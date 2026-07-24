import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

window.THREE = THREE;

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. STATE & LOADERS
// ─────────────────────────────────────────────────────────────────────────────

let scene, camera, renderer;
let reticle;
let planeIndicator;

const spawnedModels = [];
let selectedModelData = null;
let selectedPlacedEntry = null;

THREE.Cache.enabled = true;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const modelCache = {};

const PRELOAD_CONCURRENCY = 2;
let activePreloads = 0;
const preloadQueue = [];

function preloadModel(glbUrl, { priority = false } = {}) {
    if (!glbUrl || modelCache[glbUrl]) return modelCache[glbUrl];

    const promise = new Promise((resolve, reject) => {
        const job = () => {
            activePreloads++;
            gltfLoader.load(
                glbUrl,
                (gltf) => {
                    activePreloads--;
                    resolve(gltf.scene);
                    pumpPreloadQueue();
                },
                undefined,
                (err) => {
                    activePreloads--;
                    console.error('[preloadModel] Load error:', err);
                    delete modelCache[glbUrl];
                    reject(err);
                    pumpPreloadQueue();
                }
            );
        };

        if (priority) {
            preloadQueue.unshift(job);
        } else {
            preloadQueue.push(job);
        }
    });

    modelCache[glbUrl] = promise;
    pumpPreloadQueue();
    return promise;
}

function pumpPreloadQueue() {
    while (activePreloads < PRELOAD_CONCURRENCY && preloadQueue.length > 0) {
        const job = preloadQueue.shift();
        job();
    }
}

const cssReticle = document.getElementById('reticle');
const hintEl = document.getElementById('placement-hint');
const placeBtn = document.getElementById('place-btn');

const MISS_TOLERANCE_FRAMES = 6;
let missStreak = 0;
let surfaceLocked = false;
const SCANNING_HINT = 'Move your device slowly to scan for a surface…';
const READY_HINT = "Aim at a surface and tap 'Place Model'";

const TAP_MOVE_THRESHOLD = 10;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLACED MODEL SELECTION & HIGHLIGHTING
// ─────────────────────────────────────────────────────────────────────────────

function selectPlacedModel(entry) {
    // Hide all selection boxes first
    spawnedModels.forEach(e => {
        const box = e.mesh.getObjectByName('selectionBox');
        if (box) box.visible = false;
    });

    selectedPlacedEntry = entry;
    const deleteBtn = document.getElementById('delete-selected-btn');

    if (entry) {
        const box = entry.mesh.getObjectByName('selectionBox');
        if (box) box.visible = true;
        deleteBtn.style.display = 'inline-flex';
    } else {
        deleteBtn.style.display = 'none';
    }
}

function handleCanvasTap(clientX, clientY) {
    if (!camera || !scene) return;

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const targetMeshes = spawnedModels.map(item => item.mesh);
    const intersects = raycaster.intersectObjects(targetMeshes, true);

    if (intersects.length > 0) {
        let topObj = intersects[0].object;
        while (topObj.parent && topObj.parent !== scene) {
            topObj = topObj.parent;
        }

        const matchedEntry = spawnedModels.find(e => e.mesh === topObj);
        if (matchedEntry) {
            selectPlacedModel(matchedEntry);
            return;
        }
    }

    selectPlacedModel(null);
}

function moveSelectedModel(clientX, clientY) {
    if (!selectedPlacedEntry || !window.XR8 || !window.XR8.XrController) return;

    const nx = clientX / window.innerWidth;
    const ny = clientY / window.innerHeight;
    const results = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
    const hit = pickBestHit(results);
    if (!hit) return;

    selectedPlacedEntry.mesh.position.set(hit.position.x, hit.position.y, hit.position.z);
}

function angleBetweenTouches(touches) {
    return Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
}

const _upVec = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _reusableQuat = new THREE.Quaternion();

function classifyPlaneOrientation(rotation) {
    if (!rotation || typeof rotation.x !== 'number') return 'horizontal';

    const q = _reusableQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    _upVec.set(0, 1, 0).applyQuaternion(q);
    const alignment = Math.abs(_upVec.dot(_worldUp));

    if (alignment > 0.85) return 'horizontal';
    return 'non-horizontal';
}

function pickBestHit(hitTestResults) {
    const planeHits = hitTestResults?.filter((h) => h.type === 'ESTIMATED_SURFACE_PLANE') ?? [];
    if (planeHits.length > 0) {
        const horizontalHit = planeHits.find((h) => classifyPlaneOrientation(h.rotation) === 'horizontal');
        if (horizontalHit) return horizontalHit;
        return planeHits[0];
    }

    const featureHits = hitTestResults?.filter((h) => h.type === 'FEATURE_POINT') ?? [];
    if (featureHits.length > 0) {
        const hit = featureHits[0];
        if (!hit.rotation) {
            hit.rotation = { x: 0, y: 0, z: 0, w: 1 };
        }
        return hit;
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 8TH WALL PIPELINE LOGIC (SLAM ENGINE)
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    let touchStartX = 0;
    let touchStartY = 0;
    let groundPlane; // Module-scoped to track SLAM height dynamically

    return {
        name: 'ar-staging-logic',
        onStart: ({ canvas }) => {
            if (!XR8.Threejs || !XR8.Threejs.xrScene) {
                console.error('8th Wall Three.js pipeline not available.');
                hintEl.textContent = 'AR initialization failed. Please reload.';
                hintEl.classList.add('show-hint');
                return;
            }

            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            if (renderer && renderer.setPixelRatio) {
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            }

            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;

            const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
            light.position.set(0.5, 1, 0.25);
            scene.add(light);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
            dirLight.position.set(1, 4, 2);
            dirLight.castShadow = true;
            dirLight.shadow.mapSize.width = 1024;
            dirLight.shadow.mapSize.height = 1024;
            dirLight.shadow.camera.near = 0.1;
            dirLight.shadow.camera.far = 10;
            dirLight.shadow.bias = -0.001;
            scene.add(dirLight);

            reticle = new THREE.Object3D();
            scene.add(reticle);

            const planeIndicatorGeo = new THREE.BoxGeometry(0.5, 0.01, 0.5);
            const planeIndicatorMat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.16,
                depthWrite: false,
            });
            planeIndicator = new THREE.Mesh(planeIndicatorGeo, planeIndicatorMat);
            planeIndicator.visible = false;
            scene.add(planeIndicator);

            // Dynamic floor tracking shadow plane
            groundPlane = new THREE.Mesh(
                new THREE.PlaneGeometry(100, 100),
                new THREE.ShadowMaterial({ opacity: 0.35 })
            );
            groundPlane.rotation.x = -Math.PI / 2;
            groundPlane.receiveShadow = true;
            scene.add(groundPlane);

            let isDragging = false;
            let isRotating = false;
            let rotateStartAngle = 0;
            let rotateStartY = 0;

            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    isDragging = false;
                    isRotating = false;
                } else if (e.touches.length === 2 && selectedPlacedEntry) {
                    isRotating = true;
                    isDragging = false;
                    rotateStartAngle = angleBetweenTouches(e.touches);
                    rotateStartY = selectedPlacedEntry.mesh.rotation.y;
                }
            }, { passive: true });

            canvas.addEventListener('touchmove', (e) => {
                if (isRotating && e.touches.length === 2 && selectedPlacedEntry) {
                    const currentAngle = angleBetweenTouches(e.touches);
                    selectedPlacedEntry.mesh.rotation.y = rotateStartY + (currentAngle - rotateStartAngle);
                    return;
                }

                if (e.touches.length === 1 && selectedPlacedEntry) {
                    const touch = e.touches[0];
                    if (!isDragging) {
                        const dx = touch.clientX - touchStartX;
                        const dy = touch.clientY - touchStartY;
                        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) {
                            isDragging = true;
                        }
                    }
                    if (isDragging) {
                        moveSelectedModel(touch.clientX, touch.clientY);
                    }
                }
            }, { passive: true });

            canvas.addEventListener('touchend', (e) => {
                if (isRotating) {
                    isRotating = false;
                    return;
                }
                if (isDragging) {
                    isDragging = false;
                    return;
                }
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;

                    if (Math.hypot(endX - touchStartX, endY - touchStartY) < TAP_MOVE_THRESHOLD) {
                        handleCanvasTap(endX, endY);
                    }
                }
            });

            updatePlacementAvailability(false);
        },
        onUpdate: () => {
            if (!scene) return;

            const hitTestResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
            const hit = pickBestHit(hitTestResults);

            if (hit) {
                missStreak = 0;

                const p = hit.position;
                const r = hit.rotation;
                reticle.position.set(p.x, p.y, p.z);
                reticle.quaternion.set(r.x, r.y, r.z, r.w);
                planeIndicator.position.copy(reticle.position);
                planeIndicator.quaternion.copy(reticle.quaternion);

                // Snap global shadow height directly to the detected floor
                if (groundPlane) groundPlane.position.y = p.y;

                if (!surfaceLocked) {
                    surfaceLocked = true;
                    cssReticle.classList.add('locked');
                    planeIndicator.visible = true;
                    updatePlacementAvailability(true);
                }
            } else {
                missStreak += 1;
                if (missStreak > MISS_TOLERANCE_FRAMES && surfaceLocked) {
                    surfaceLocked = false;
                    cssReticle.classList.remove('locked');
                    planeIndicator.visible = false;
                    updatePlacementAvailability(false);
                }
            }
        }
    };
};

const onxrloaded = () => {
    XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        window.XRExtras.AlmostThere.pipelineModule(),
        window.XRExtras.FullWindowCanvas.pipelineModule(),
        window.XRExtras.Loading.pipelineModule(),
        window.XRExtras.RuntimeError.pipelineModule(),
        arStagingPipelineModule(),
    ]);

    XR8.run({ canvas: document.getElementById('camera-canvas') });
};

if (window.XR8) {
    onxrloaded();
} else {
    window.addEventListener('xrloaded', onxrloaded);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UI CONTROLS & DYNAMIC BUTTON HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function updateBudget() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    document.getElementById('budget-value').textContent = `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function updatePlacementAvailability(ready) {
    placeBtn.disabled = !ready;
    placeBtn.style.opacity = ready ? '1' : '0.4';
    placeBtn.style.pointerEvents = ready ? 'auto' : 'none';

    if (selectedModelData) {
        hintEl.textContent = ready ? READY_HINT : SCANNING_HINT;
    }
}

const catalogDrawer = document.getElementById('catalog-drawer');
const hamburgerBtn = document.getElementById('hamburger-btn');
const closeDrawerBtn = document.getElementById('close-drawer-btn');

function toggleDrawer(open) {
    if (open === undefined) {
        catalogDrawer.classList.toggle('collapsed');
    } else if (open) {
        catalogDrawer.classList.remove('collapsed');
    } else {
        catalogDrawer.classList.add('collapsed');
    }
}

hamburgerBtn.addEventListener('click', () => toggleDrawer());
closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));

document.getElementById('clear-btn').addEventListener('click', () => {
    selectPlacedModel(null);
    spawnedModels.forEach(entry => {
        scene.remove(entry.mesh);
        disposeHierarchy(entry.mesh);
    });
    spawnedModels.length = 0;
    updateBudget();
});

document.getElementById('delete-selected-btn').addEventListener('click', () => {
    if (!selectedPlacedEntry) return;

    const entryToDelete = selectedPlacedEntry;
    selectPlacedModel(null);

    scene.remove(entryToDelete.mesh);
    disposeHierarchy(entryToDelete.mesh);

    const idx = spawnedModels.indexOf(entryToDelete);
    if (idx !== -1) {
        spawnedModels.splice(idx, 1);
    }
    updateBudget();
});

placeBtn.addEventListener('click', () => {
    if (selectedModelData && surfaceLocked) {
        spawnModelAtReticle(selectedModelData);
    }
});

function deepCloneModel(source) {
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

function disposeHierarchy(root) {
    root.traverse((node) => {
        if (node.isMesh) {
            node.geometry?.dispose();
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            mats.forEach(m => m?.dispose());
        }
    });
}

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;

    cssReticle.classList.add('flash');
    setTimeout(() => cssReticle.classList.remove('flash'), 200);

    const placementPosition = reticle.position.clone();

    const templatePromise = modelCache[glbUrl] || preloadModel(glbUrl, { priority: true });

    templatePromise
        .then((template) => {
            const modelRoot = deepCloneModel(template);
            addMeshToScene(modelRoot, modelData, placementPosition);
        })
        .catch((err) => console.error('[spawnModel] Load error:', err));
}

function addMeshToScene(mesh, modelData, placementPosition) {
    const wrapper = new THREE.Group();

    // An inner wrapper absorbs the model's footprint offset without breaking local scale
    const innerWrapper = new THREE.Group();
    wrapper.add(innerWrapper);
    innerWrapper.add(mesh);

    // Temporarily center to compute clean footprint bounds
    wrapper.position.set(0, 0, 0);
    wrapper.rotation.set(0, 0, 0);
    wrapper.scale.set(1, 1, 1);

    innerWrapper.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(innerWrapper);

    if (!box.isEmpty()) {
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Shift innerWrapper so the model's bottom-center sits flawlessly at (0,0,0) locally
        innerWrapper.position.x = -center.x;
        innerWrapper.position.z = -center.z;
        innerWrapper.position.y = -box.min.y;
    }

    // Apply the spatial placement position
    wrapper.position.copy(placementPosition);

    // Orient the wrapper to immediately face the camera
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    wrapper.rotation.y = Math.atan2(-cameraDirection.x, -cameraDirection.z);

    mesh.traverse((node) => {
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });

    // Create an oriented Selection Box explicitly attached to the wrapper
    const finalBox = new THREE.Box3().setFromObject(innerWrapper);
    const size = new THREE.Vector3();
    finalBox.getSize(size);

    const boxGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    const edges = new THREE.EdgesGeometry(boxGeo);
    const selectionBox = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({
        color: 0x34c759, // Standardized active-green for 47 XLVII
        depthTest: false,
        transparent: true
    }));

    selectionBox.position.set(0, size.y / 2, 0);
    selectionBox.name = 'selectionBox';
    selectionBox.visible = false;
    wrapper.add(selectionBox);

    scene.add(wrapper);

    const entry = { mesh: wrapper, price: modelData.price, glbUrl: modelData.glbUrl };
    spawnedModels.push(entry);

    if (spawnedModels.length === 1) {
        hintEl.classList.remove('show-hint');
        hintEl.style.display = 'none';
    }

    selectPlacedModel(entry);
    updateBudget();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FIREBASE CATALOG INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

const firebaseConfig = {
    apiKey: 'AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY',
    authDomain: 'shot47-database.firebaseapp.com',
    projectId: 'shot47-database',
    storageBucket: 'shot47-database.firebasestorage.app',
    messagingSenderId: '77237094269',
    appId: '1:77237094269:web:a90a6c6239cb66e3102e14',
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

const registry = { furniture: [], carpets: [], decor: [] };
let activeCategory = 'furniture';

const collectionMap = {
    furniture: 'furniture_models',
    carpets: 'carpet_models',
    decor: 'decor_models',
};

async function resolveUrl(pathOrUrl, folder) {
    if (!pathOrUrl) return null;
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    return getDownloadURL(ref(storage, `${folder}/${pathOrUrl}`));
}

function selectCatalogModel(card, assetData) {
    document.querySelectorAll('.catalog-item').forEach(el => el.classList.remove('selected'));
    card.classList.add('selected');
    selectedModelData = assetData;

    placeBtn.style.display = 'inline-flex';
    hintEl.classList.add('show-hint');
    updatePlacementAvailability(surfaceLocked);
}

function renderCatalog(category) {
    const list = document.getElementById('catalog-list');
    list.innerHTML = '';
    const assets = registry[category] ?? [];

    if (assets.length === 0) {
        list.innerHTML = '<div class="empty-notice">Updating digital catalog…</div>';
        return;
    }

    assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'catalog-item state-loading';
        card.innerHTML = `
            <div class="thumb-wrapper"><img class="catalog-thumb" alt="${asset.title}" /></div>
            <div class="card-meta"><span>${asset.title}</span></div>
        `;
        list.appendChild(card);

        const img = card.querySelector('.catalog-thumb');
        if (asset.imgName) {
            resolveUrl(asset.imgName, 'models/thumbnails')
                .then((url) => { img.src = url; })
                .catch(() => { });
        }

        resolveUrl(asset.glbName, 'models/glb')
            .then((glbUrl) => {
                card.classList.remove('state-loading');
                const assetData = { glbUrl, price: asset.price };
                const isFirstCard = list.children[0] === card;

                preloadModel(glbUrl, { priority: isFirstCard });

                card.addEventListener('click', () => {
                    selectCatalogModel(card, assetData);
                    preloadModel(glbUrl, { priority: true });
                });

                if (!selectedModelData && isFirstCard) {
                    selectCatalogModel(card, assetData);
                }
            })
            .catch(() => {
                card.classList.remove('state-loading');
                card.style.opacity = '0.3';
            });
    });
}

function initCatalogSync() {
    Object.entries(collectionMap).forEach(([category, collectionName]) => {
        onSnapshot(collection(db, collectionName), (snapshot) => {
            registry[category] = [];
            snapshot.forEach((doc) => {
                const d = doc.data();
                if (!d.glb) return;
                registry[category].push({
                    title: d.title ?? 'Unnamed',
                    glbName: d.glb,
                    imgName: d.img ?? null,
                    price: d.price ?? 349.00
                });
            });
            if (category === activeCategory) renderCatalog(activeCategory);
        });
    });
}

document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
        e.currentTarget.classList.add('active');
        activeCategory = e.currentTarget.dataset.category;
        renderCatalog(activeCategory);
    });
});

initCatalogSync();