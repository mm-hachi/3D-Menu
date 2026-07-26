import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { initializeFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

window.THREE = THREE;

/**
 * 47 | XLVII - Spatial Staging Environment
 * Core Application Architecture
 */

class FirebaseService {
    constructor(uiManager, assetLoader) {
        this.uiManager = uiManager;
        this.assetLoader = assetLoader;

        // Retaining technical keys, but branding reflects 47/XLVII
        this.config = {
            apiKey: 'AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY',
            authDomain: 'shot47-database.firebaseapp.com',
            projectId: 'shot47-database',
            storageBucket: 'shot47-database.firebasestorage.app',
            messagingSenderId: '77237094269',
            appId: '1:77237094269:web:a90a6c6239cb66e3102e14',
        };

        this.app = initializeApp(this.config);
        // WebChannel (Firestore's default streaming transport) can fail on
        // certain networks/proxies/mobile carriers with a "transport
        // errored" RPC error. Auto-detecting long-polling is Firebase's own
        // documented mitigation: it only falls back to long-polling if
        // streaming genuinely doesn't work, rather than forcing it always.
        this.db = initializeFirestore(this.app, { experimentalAutoDetectLongPolling: true });
        this.storage = getStorage(this.app);

        this.registry = { furniture: [], carpets: [], decor: [] };
        this.collectionMap = {
            furniture: 'furniture_models',
            carpets: 'carpet_models',
            decor: 'decor_models',
        };
    }

    async resolveUrl(pathOrUrl, folder) {
        if (!pathOrUrl) return null;
        if (pathOrUrl.startsWith('http')) return pathOrUrl;
        return getDownloadURL(ref(this.storage, `${folder}/${pathOrUrl}`));
    }

    initCatalogSync(activeCategory) {
        Object.entries(this.collectionMap).forEach(([category, collectionName]) => {
            onSnapshot(
                collection(this.db, collectionName),
                (snapshot) => {
                    this.registry[category] = [];
                    snapshot.forEach((doc) => {
                        const d = doc.data();
                        if (d.glb) {
                            this.registry[category].push({
                                title: d.title ?? 'Unnamed',
                                glbName: d.glb,
                                imgName: d.img ?? null,
                                price: d.price ?? 0.00
                            });
                        }
                    });
                    if (category === activeCategory) {
                        this.uiManager.renderCatalog(this.registry[category], this);
                    }
                },
                (err) => {
                    console.error(`[FirebaseService] Listener failed for "${collectionName}":`, err);
                }
            );
        });
    }
}

class AssetLoader {
    constructor() {
        this.cache = {};
        this.dracoLoader = new DRACOLoader();
        this.dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        this.dracoLoader.preload();

        this.gltfLoader = new GLTFLoader();
        this.gltfLoader.setDRACOLoader(this.dracoLoader);
    }

    async preloadModel(glbUrl) {
        if (!glbUrl) return null;
        if (this.cache[glbUrl]) return this.cache[glbUrl];

        const loadPromise = new Promise((resolve, reject) => {
            this.gltfLoader.load(glbUrl, (gltf) => resolve(gltf.scene), undefined, reject);
        });

        this.cache[glbUrl] = loadPromise;
        return loadPromise;
    }

    deepClone(source) {
        const clone = source.clone(true);
        clone.traverse((node) => {
            if (node.isMesh) {
                if (node.geometry) node.geometry = node.geometry.clone();
                if (Array.isArray(node.material)) {
                    node.material = node.material.map(m => m.clone());
                } else if (node.material) {
                    node.material = node.material.clone();
                }
            }
        });
        return clone;
    }
}

class UIManager {
    constructor(appContext) {
        this.appContext = appContext;
        this.activeCategory = 'furniture';
        this.selectedModelData = null;

        this.elements = {
            hint: document.getElementById('placement-hint'),
            placeBtn: document.getElementById('place-btn'),
            budget: document.getElementById('budget-value'),
            catalogList: document.getElementById('catalog-list'),
            drawer: document.getElementById('catalog-drawer'),
            hamburger: document.getElementById('hamburger-btn'),
            closeDrawer: document.getElementById('close-drawer-btn'),
            clearBtn: document.getElementById('clear-btn'),
            deleteBtn: document.getElementById('delete-selected-btn'),
            tabs: document.querySelectorAll('.tab-btn'),
            reticle: document.getElementById('reticle')
        };

        this.bindEvents();
    }

    bindEvents() {
        this.elements.hamburger.addEventListener('click', () => this.elements.drawer.classList.remove('collapsed'));
        this.elements.closeDrawer.addEventListener('click', () => this.elements.drawer.classList.add('collapsed'));

        this.elements.tabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                this.elements.tabs.forEach(t => t.classList.remove('active'));
                e.currentTarget.classList.add('active');
                this.activeCategory = e.currentTarget.dataset.category;
                this.renderCatalog(this.appContext.firebase.registry[this.activeCategory], this.appContext.firebase);
            });
        });

        this.elements.clearBtn.addEventListener('click', () => this.appContext.arScene.clearAllModels());
        this.elements.deleteBtn.addEventListener('click', () => this.appContext.arScene.deleteSelectedModel());
        this.elements.placeBtn.addEventListener('click', () => {
            if (this.selectedModelData && this.appContext.arScene.surfaceLocked) {
                this.appContext.arScene.spawnModel(this.selectedModelData);
            }
        });
    }

    updateBudget(models) {
        const total = models.reduce((sum, item) => sum + (item.price || 0), 0);
        this.elements.budget.textContent = `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    updatePlacementAvailability(isLocked) {
        this.elements.placeBtn.disabled = !isLocked;
        this.elements.placeBtn.style.opacity = isLocked ? '1' : '0.4';
        this.elements.placeBtn.style.pointerEvents = isLocked ? 'auto' : 'none';

        if (this.selectedModelData) {
            this.elements.hint.textContent = isLocked ? "Aim at a surface and tap 'Place Model'" : 'Move your device slowly to scan...';
        }
    }

    toggleDeleteButton(show) {
        this.elements.deleteBtn.style.display = show ? 'inline-flex' : 'none';
    }

    flashReticle() {
        this.elements.reticle.classList.add('flash');
        setTimeout(() => this.elements.reticle.classList.remove('flash'), 200);
    }

    renderCatalog(assets, firebaseService) {
        this.elements.catalogList.innerHTML = '';
        if (!assets || assets.length === 0) {
            this.elements.catalogList.innerHTML = '<div class="empty-notice">Updating digital catalog…</div>';
            return;
        }

        assets.forEach((asset, index) => {
            const card = document.createElement('div');
            card.className = 'catalog-item state-loading';
            card.innerHTML = `
                <div class="thumb-wrapper"><img class="catalog-thumb" alt="${asset.title}" /></div>
                <div class="card-meta"><span>${asset.title}</span></div>
            `;
            this.elements.catalogList.appendChild(card);

            const img = card.querySelector('.catalog-thumb');
            if (asset.imgName) {
                firebaseService.resolveUrl(asset.imgName, 'models/thumbnails')
                    .then(url => img.src = url)
                    .catch(err => console.error(`[UIManager] Thumbnail failed for "${asset.title}":`, err));
            }

            firebaseService.resolveUrl(asset.glbName, 'models/glb')
                .then(glbUrl => {
                    card.classList.remove('state-loading');
                    const assetData = { glbUrl, price: asset.price };

                    card.addEventListener('click', () => {
                        document.querySelectorAll('.catalog-item').forEach(el => el.classList.remove('selected'));
                        card.classList.add('selected');
                        this.selectedModelData = assetData;
                        this.elements.placeBtn.style.display = 'inline-flex';
                        this.elements.hint.classList.add('show-hint');
                        this.updatePlacementAvailability(this.appContext.arScene.surfaceLocked);
                        this.appContext.assetLoader.preloadModel(glbUrl)
                            .catch(err => console.error(`[UIManager] Preload failed for "${asset.title}":`, err));
                    });

                    if (index === 0 && !this.selectedModelData) {
                        card.click();
                    }
                })
                .catch(err => {
                    card.classList.remove('state-loading');
                    card.style.opacity = '0.3';
                    console.error(`[UIManager] GLB URL resolution failed for "${asset.title}":`, err);
                });
        });
    }
}

class InputController {
    constructor(arScene) {
        this.arScene = arScene;
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();

        this.isDragging = false;
        this.isRotating = false;
        this.touchStartedOnModel = false; // drag is only ever allowed if the touch actually began on the selected model
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.rotateStartAngle = 0;
        this.rotateStartY = 0;
        this.TAP_THRESHOLD = 10;
    }

    bindCanvas(canvas) {
        canvas.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: true });
        canvas.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: true });
        canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
    }

    // Raycasts a screen point against a given set of meshes and returns the
    // matching top-level spawnedModels entry, or null.
    raycastForModel(x, y, meshes) {
        if (!this.arScene.camera || !this.arScene.scene || meshes.length === 0) return null;

        this.pointer.x = (x / window.innerWidth) * 2 - 1;
        this.pointer.y = -(y / window.innerHeight) * 2 + 1;
        this.raycaster.setFromCamera(this.pointer, this.arScene.camera);

        const intersects = this.raycaster.intersectObjects(meshes, true);
        if (intersects.length === 0) return null;

        let topObj = intersects[0].object;
        while (topObj.parent && topObj.parent !== this.arScene.scene) {
            topObj = topObj.parent;
        }
        return this.arScene.spawnedModels.find(e => e.mesh === topObj) || null;
    }

    onTouchStart(e) {
        if (e.touches.length === 1) {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
            this.isDragging = false;
            this.isRotating = false;

            // Only allow a subsequent drag if this touch actually landed on
            // the currently selected model — otherwise a tap on open space
            // (which always has a little natural jitter) gets misread as
            // "drag the selected model" instead of deselecting it.
            this.touchStartedOnModel = this.arScene.selectedModel
                ? this.raycastForModel(this.touchStartX, this.touchStartY, [this.arScene.selectedModel.mesh]) !== null
                : false;
        } else if (e.touches.length === 2 && this.arScene.selectedModel) {
            this.isRotating = true;
            this.isDragging = false;
            this.rotateStartAngle = this.getAngle(e.touches);
            this.rotateStartY = this.arScene.selectedModel.mesh.rotation.y;
        }
    }

    onTouchMove(e) {
        if (this.isRotating && e.touches.length === 2 && this.arScene.selectedModel) {
            const currentAngle = this.getAngle(e.touches);
            // Screen-space angle is measured with Y increasing downward;
            // world-space rotation.y increases the opposite sense, so the
            // raw delta was rotating the model backwards relative to the
            // twist gesture. Negating it corrects the direction.
            this.arScene.selectedModel.mesh.rotation.y = this.rotateStartY - (currentAngle - this.rotateStartAngle);
            return;
        }

        if (e.touches.length === 1 && this.arScene.selectedModel && this.touchStartedOnModel) {
            const touch = e.touches[0];
            if (!this.isDragging) {
                const dist = Math.hypot(touch.clientX - this.touchStartX, touch.clientY - this.touchStartY);
                if (dist > this.TAP_THRESHOLD) this.isDragging = true;
            }
            if (this.isDragging) {
                this.arScene.moveSelectedToScreenCoords(touch.clientX, touch.clientY);
            }
        }
    }

    onTouchEnd(e) {
        if (this.isRotating || this.isDragging) {
            this.isRotating = false;
            this.isDragging = false;
            return;
        }
        if (e.changedTouches.length === 1) {
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            if (Math.hypot(endX - this.touchStartX, endY - this.touchStartY) < this.TAP_THRESHOLD) {
                this.handleTap(endX, endY);
            }
        }
    }

    getAngle(touches) {
        return Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
    }

    handleTap(x, y) {
        const meshes = this.arScene.spawnedModels.map(m => m.mesh);
        const matched = this.raycastForModel(x, y, meshes);
        this.arScene.selectModel(matched);
    }
}

class ARScene {
    constructor(appContext) {
        this.appContext = appContext;
        this.scene = null;
        this.camera = null;
        this.renderer = null;

        this.reticle = null;
        this.planeIndicator = null;
        this.groundPlane = null;

        this.spawnedModels = [];
        this.selectedModel = null;
        this.surfaceLocked = false;

        this.inputController = new InputController(this);
    }

    createPipelineModule() {
        return {
            name: 'staging-app',
            onStart: ({ canvas }) => {
                console.log('[ARScene] onStart fired — XR8 pipeline is running.');
                if (typeof XR8?.XrController?.hitTest !== 'function') {
                    console.error('[ARScene] XR8.XrController.hitTest is not available — SLAM tracking did not initialize.');
                }

                const { scene, camera, renderer } = XR8.Threejs.xrScene();
                this.scene = scene;
                this.camera = camera;
                this.renderer = renderer;

                // Responsive Scale derives its scale reference from the
                // camera's Y position at the moment tracking starts. This
                // has never been set, so it's been defaulting to 0 — a
                // degenerate reference height that's the likely cause of
                // the wild scale swings. ~1.4m approximates a typical
                // hand-held phone height when aiming at floor-level
                // furniture; tune this single number if placed models
                // consistently read as uniformly too large or too small.
                const ASSUMED_CAMERA_HEIGHT_METERS = 1.4;
                camera.position.set(0, ASSUMED_CAMERA_HEIGHT_METERS, 0);

                this.renderer.shadowMap.enabled = true;
                this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

                this.setupLighting();
                this.setupIndicators();
                this.inputController.bindCanvas(canvas);

                this.appContext.uiManager.updatePlacementAvailability(false);
            },
            onUpdate: () => this.updateSLAM()
        };
    }

    setupLighting() {
        const ambient = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
        ambient.position.set(0.5, 1, 0.25);
        this.scene.add(ambient);

        const directional = new THREE.DirectionalLight(0xffffff, 1.2);
        directional.position.set(1, 4, 2);
        directional.castShadow = true;
        directional.shadow.mapSize.set(1024, 1024);
        directional.shadow.bias = -0.001;
        this.scene.add(directional);
    }

    setupIndicators() {
        this.reticle = new THREE.Object3D();
        this.scene.add(this.reticle);

        const geo = new THREE.BoxGeometry(0.5, 0.01, 0.5);
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
        this.planeIndicator = new THREE.Mesh(geo, mat);
        this.planeIndicator.visible = false;
        this.scene.add(this.planeIndicator);

        this.groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.ShadowMaterial({ opacity: 0.35 }));
        this.groundPlane.rotation.x = -Math.PI / 2;
        this.groundPlane.receiveShadow = true;
        this.scene.add(this.groundPlane);
    }

    updateSLAM() {
        if (!this.scene || !window.XR8) return;

        const hit = this.pickBestHit();

        if (hit) {
            this.reticle.position.copy(hit.position);

            // Add a safety check in case the SLAM engine hits a point without full 6DoF rotation data
            if (hit.rotation) {
                this.reticle.quaternion.copy(hit.rotation);
                this.planeIndicator.quaternion.copy(hit.rotation);
            }

            this.planeIndicator.position.copy(hit.position);

            // Only sync the floor shadow-catcher on a horizontal hit — a
            // wall hit has no bearing on where the actual floor is.
            if (this.classifyPlane(hit.rotation) === 'horizontal') {
                this.groundPlane.position.y = hit.position.y;
            }

            if (!this.surfaceLocked) {
                this.surfaceLocked = true;
                this.planeIndicator.visible = true;
                this.appContext.uiManager.elements.reticle.classList.add('locked');
                this.appContext.uiManager.updatePlacementAvailability(true);
            }
        } else if (this.surfaceLocked) {
            this.surfaceLocked = false;
            this.planeIndicator.visible = false;
            this.appContext.uiManager.elements.reticle.classList.remove('locked');
            this.appContext.uiManager.updatePlacementAvailability(false);
        }
    }

    // Distinguishes a floor/tabletop from a wall by checking how aligned the
    // hit's rotation is with world-up. FEATURE_POINT hits still carry a real,
    // locally-fitted rotation (not a fabricated one) — this just categorizes
    // it after the fact, e.g. for deciding whether to sync the floor shadow.
    classifyPlane(rotation) {
        if (!rotation) return 'horizontal';
        const q = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const alignment = Math.abs(up.dot(new THREE.Vector3(0, 1, 0)));
        if (alignment > 0.8) return 'horizontal';
        if (alignment < 0.35) return 'vertical';
        return 'angled';
    }

    // 8th Wall's own hitTest() reference only ever documents 'FEATURE_POINT'
    // as a valid includedTypes value — there is no confirmed
    // 'ESTIMATED_SURFACE_PLANE' type in the real API. Filtering for it (as
    // this used to) silently discarded every result, forever, with no error.
    //
    // hitTest can return multiple candidates along the same ray (e.g. a
    // floor point behind a nearer, noisier point). Preferring whichever
    // candidate reads as horizontal — rather than just taking whatever
    // comes back first — makes floor detection noticeably more reliable
    // for furniture placement.
    pickBestHit() {
        try {
            const results = XR8.XrController.hitTest(0.5, 0.5, ['FEATURE_POINT']);
            if (results.length === 0) return null;
            return results.find((h) => this.classifyPlane(h.rotation) === 'horizontal') || results[0];
        } catch (err) {
            if (!this._hitTestErrorLogged) {
                this._hitTestErrorLogged = true;
                console.error('[ARScene] XR8.XrController.hitTest() threw — SLAM tracking may not be initialized:', err);
            }
            return null;
        }
    }

    moveSelectedToScreenCoords(x, y) {
        if (!this.selectedModel || !window.XR8) return;
        const nx = x / window.innerWidth;
        const ny = y / window.innerHeight;

        let hit = null;
        try {
            const results = XR8.XrController.hitTest(nx, ny, ['FEATURE_POINT']);
            hit = results.length > 0 ? (results.find((h) => this.classifyPlane(h.rotation) === 'horizontal') || results[0]) : null;
        } catch (err) {
            console.error('[ARScene] hitTest() threw during drag:', err);
        }

        if (hit) {
            this.selectedModel.mesh.position.copy(hit.position);
        }
    }

    async spawnModel(modelData) {
        this.appContext.uiManager.flashReticle();

        let template;
        try {
            template = await this.appContext.assetLoader.preloadModel(modelData.glbUrl);
        } catch (err) {
            console.error('[ARScene] Failed to load model for placement:', err);
            return;
        }
        if (!template) return;

        const mesh = this.appContext.assetLoader.deepClone(template);
        const wrapper = new THREE.Group();
        const innerWrapper = new THREE.Group();

        wrapper.add(innerWrapper);
        innerWrapper.add(mesh);

        innerWrapper.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(innerWrapper);

        if (!box.isEmpty()) {
            const center = new THREE.Vector3();
            box.getCenter(center);
            innerWrapper.position.set(-center.x, -box.min.y, -center.z); // Perfect local zeroing
        }

        wrapper.position.copy(this.reticle.position);

        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        wrapper.rotation.y = Math.atan2(-camDir.x, -camDir.z); // Face camera

        mesh.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });

        const finalBox = new THREE.Box3().setFromObject(innerWrapper);
        const size = new THREE.Vector3();
        finalBox.getSize(size);

        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
        const selectionBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x34c759, depthTest: false }));
        selectionBox.position.set(0, size.y / 2, 0);
        selectionBox.name = 'selectionBox';
        selectionBox.visible = false;
        wrapper.add(selectionBox);

        this.scene.add(wrapper);
        const entry = { mesh: wrapper, price: modelData.price, glbUrl: modelData.glbUrl };
        this.spawnedModels.push(entry);

        if (this.spawnedModels.length === 1) {
            this.appContext.uiManager.elements.hint.style.display = 'none';
        }

        this.selectModel(entry);
        this.appContext.uiManager.updateBudget(this.spawnedModels);
    }

    selectModel(entry) {
        this.spawnedModels.forEach(e => {
            const box = e.mesh.getObjectByName('selectionBox');
            if (box) box.visible = false;
        });

        this.selectedModel = entry;
        this.appContext.uiManager.toggleDeleteButton(!!entry);

        if (entry) {
            const box = entry.mesh.getObjectByName('selectionBox');
            if (box) box.visible = true;
        }
    }

    disposeHierarchy(root) {
        root.traverse(node => {
            if (node.isMesh) {
                node.geometry?.dispose();
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                mats.forEach(m => m?.dispose());
            }
        });
    }

    deleteSelectedModel() {
        if (!this.selectedModel) return;
        this.scene.remove(this.selectedModel.mesh);
        this.disposeHierarchy(this.selectedModel.mesh);
        this.spawnedModels = this.spawnedModels.filter(m => m !== this.selectedModel);
        this.selectModel(null);
        this.appContext.uiManager.updateBudget(this.spawnedModels);
    }

    clearAllModels() {
        this.selectModel(null);
        this.spawnedModels.forEach(m => {
            this.scene.remove(m.mesh);
            this.disposeHierarchy(m.mesh);
        });
        this.spawnedModels = [];
        this.appContext.uiManager.updateBudget(this.spawnedModels);
    }
}

class ARApp {
    constructor() {
        this.assetLoader = new AssetLoader();
        this.uiManager = new UIManager(this);
        this.firebase = new FirebaseService(this.uiManager, this.assetLoader);
        this.arScene = new ARScene(this);
    }

    start() {
        this.firebase.initCatalogSync(this.uiManager.activeCategory);

        const onxrloaded = () => {
            // Must be configured before XR8.XrController.pipelineModule() is
            // added to the pipeline — 8th Wall's docs are explicit that this
            // kind of setting can't be changed once the engine is running,
            // and other configure() flags (e.g. disableWorldTracking) are
            // documented as needing to be set before the pipeline module is
            // even added, not just before XR8.run(). By default 8th Wall
            // uses "Responsive Scale", which re-derives scale from camera
            // height continuously as you move — that's what was causing
            // models to grow/shrink/drift. Absolute Scale uses the device's
            // actual measured camera height instead.
            // Absolute Scale requires an additional "Coaching Overlay"
            // pipeline module to calibrate camera height (the user waves
            // their phone back and forth) — without it there's nothing to
            // calibrate against. It's also independently reported by other
            // 8th Wall developers as jittery/unstable even when set up
            // correctly. Responsive Scale (8th Wall's documented default,
            // and their own recommended "ideal experience" in most cases)
            // is more stable — it just needs a sensible starting camera
            // height, set below in onStart, instead of the default (0,0,0).
            XR8.XrController.configure({ scale: 'responsive' });

            XR8.addCameraPipelineModules([
                XR8.GlTextureRenderer.pipelineModule(),
                XR8.Threejs.pipelineModule(),
                XR8.XrController.pipelineModule(),
                window.XRExtras.AlmostThere.pipelineModule(),
                window.XRExtras.FullWindowCanvas.pipelineModule(),
                window.XRExtras.Loading.pipelineModule(),
                window.XRExtras.RuntimeError.pipelineModule(),
                this.arScene.createPipelineModule()
            ]);

            XR8.run({ canvas: document.getElementById('camera-canvas') });
        };

        if (window.XR8) {
            onxrloaded();
        } else {
            window.addEventListener('xrloaded', onxrloaded);
        }
    }
}

// Bootstrap
const app = new ARApp();
app.start();