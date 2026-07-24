import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

window.THREE = THREE;

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. STATE MANAGEMENT & ASSET PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

let scene, camera, renderer;
let reticle, planeIndicator, selectionBoxHelper, shadowPlane;

const spawnedModels = [];
let selectedModelData = null;
let selectedPlacedEntry = null;

// Three.js Cache & Loaders
THREE.Cache.enabled = true;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const modelCache = {};
const PRELOAD_CONCURRENCY = 3;
let activePreloads = 0;
const preloadQueue = [];

// Pre-fetches and parses GLTF models into memory for zero-latency spawning
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
                    console.error('[Preloader] Failed to load model:', err);
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

// UI Elements
const cssReticle = document.getElementById('reticle');
const hintEl = document.getElementById('placement-hint');
const placeBtn = document.getElementById('place-btn');
const deleteBtn = document.getElementById('delete-selected-btn');

let surfaceLocked = false;
let missStreak = 0;
const MISS_TOLERANCE_FRAMES = 5;

const SCANNING_HINT = 'Move your device slowly to map the floor…';
const READY_HINT = "Point at the floor and tap 'Place Model'";

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const TAP_MOVE_THRESHOLD = 12;

// ─────────────────────────────────────────────────────────────────────────────
// 2. ULTRA-FAST GROUND IDENTIFICATION & HIT-TESTING
// ─────────────────────────────────────────────────────────────────────────────

const _upVec = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _tempQuat = new THREE.Quaternion();

function classifyPlaneOrientation(rotation) {
    if (!rotation || typeof rotation.x !== 'number') return 'horizontal';
    _tempQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    _upVec.set(0, 1, 0).applyQuaternion(_tempQuat);
    const dot = Math.abs(_upVec.dot(_worldUp));
    if (dot > 0.75) return 'horizontal';
    if (dot < 0.35) return 'vertical';
    return 'angled';
}

// High-speed hit testing prioritize real horizontal surface planes for rapid floor mapping
function findFastGroundHit(hitResults) {
    if (!hitResults || hitResults.length === 0) return null;

    // 1. High Priority: Direct Horizontal Planes
    const surfacePlanes = hitResults.filter((h) => h.type === 'ESTIMATED_SURFACE_PLANE');
    if (surfacePlanes.length > 0) {
        const horizontalPlane = surfacePlanes.find((h) => classifyPlaneOrientation(h.rotation) === 'horizontal');
        if (horizontalPlane) return horizontalPlane;
        return surfacePlanes[0];
    }

    // 2. Fallback: Instant Feature Point Anchoring for low-texture floors
    const featurePoints = hitResults.filter((h) => h.type === 'FEATURE_POINT');
    if (featurePoints.length > 0) {
        const hit = featurePoints[0];
        if (!hit.rotation) {
            hit.rotation = { x: 0, y: 0, z: 0, w: 1 };
        }
        return hit;
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 8TH WALL AR PIPELINE & CANVAS INTERACTION
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    let touchStartX = 0;
    let touchStartY = 0;
    let isDragging = false;
    let isRotating = false;
    let rotateStartAngle = 0;
    let rotateStartY = 0;

    return {
        name: 'ar-staging-core',
        onStart: ({ canvas }) => {
            if (!XR8.Threejs || !XR8.Threejs.xrScene) {
                console.error('8th Wall Three.js pipeline is missing.');
                return;
            }

            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            if (renderer) {
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            }

            // Realistic AR Lighting setup
            const ambientLight = new THREE.HemisphereLight(0xffffff, 0x444455, 1.4);
            ambientLight.position.set(0, 50, 0);
            scene.add(ambientLight);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
            dirLight.position.set(2, 5, 2);
            dirLight.castShadow = true;
            dirLight.shadow.mapSize.width = 1024;
            dirLight.shadow.mapSize.height = 1024;
            dirLight.shadow.bias = -0.0005;
            scene.add(dirLight);

            // 3D Visual Reticle & Surface Indicators
            reticle = new THREE.Object3D();
            scene.add(reticle);

            const planeGeo = new THREE.PlaneGeometry(0.6, 0.6);
            const planeMat = new THREE.MeshBasicMaterial({
                color: 0x34c759,
                transparent: true,
                opacity: 0.25,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            planeIndicator = new THREE.Mesh(planeGeo, planeMat);
            planeIndicator.rotation.x = -Math.PI / 2;
            planeIndicator.visible = false;
            scene.add(planeIndicator);

            // Selection Bounding Box
            selectionBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x34c759);
            selectionBoxHelper.visible = false;
            scene.add(selectionBoxHelper);

            // Dynamic Floor Shadow Receiver
            shadowPlane = new THREE.Mesh(
                new THREE.PlaneGeometry(30, 30),
                new THREE.ShadowMaterial({ opacity: 0.3 })
            );
            shadowPlane.rotation.x = -Math.PI / 2;
            shadowPlane.receiveShadow = true;
            scene.add(shadowPlane);

            // Touch & Gesture Listeners for Manipulation
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    isDragging = false;
                    isRotating = false;
                } else if (e.touches.length === 2 && selectedPlacedEntry) {
                    isRotating = true;
                    isDragging = false;
                    rotateStartAngle = Math.atan2(
                        e.touches[1].clientY - e.touches[0].clientY,
                        e.touches[1].clientX - e.touches[0].clientX
                    );
                    rotateStartY = selectedPlacedEntry.mesh.rotation.y;
                }
            }, { passive: true });

            canvas.addEventListener('touchmove', (e) => {
                if (isRotating && e.touches.length === 2 && selectedPlacedEntry) {
                    const currentAngle = Math.atan2(
                        e.touches[1].clientY - e.touches[0].clientY,
                        e.touches[1].clientX - e.touches[0].clientX
                    );
                    selectedPlacedEntry.mesh.rotation.y = rotateStartY + (currentAngle - rotateStartAngle);
                    if (selectionBoxHelper.visible) {
                        selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
                    }
                    return;
                }

                if (e.touches.length === 1 && selectedPlacedEntry) {
                    const touch = e.touches[0];
                    if (!isDragging) {
                        const dist = Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY);
                        if (dist > TAP_MOVE_THRESHOLD) isDragging = true;
                    }
                    if (isDragging) {
                        dragSelectedModel(touch.clientX, touch.clientY);
                    }
                }
            }, { passive: true });

            canvas.addEventListener('touchend', (e) => {
                if (isRotating || isDragging) {
                    isRotating = false;
                    isDragging = false;
                    return;
                }
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;
                    if (Math.hypot(endX - touchStartX, endY - touchStartY) < TAP_MOVE_THRESHOLD) {
                        selectModelAtTouch(endX, endY);
                    }
                }
            });

            canvas.addEventListener('click', (e) => {
                selectModelAtTouch(e.clientX, e.clientY);
            });

            updatePlacementAvailability(false);
        },

        onUpdate: () => {
            if (!scene || !window.XR8 || !window.XR8.XrController) return;

            // Perform rapid center-screen hit-test
            const hitResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
            const groundHit = findFastGroundHit(hitResults);

            if (groundHit) {
                missStreak = 0;
                const p = groundHit.position;
                const r = groundHit.rotation;

                // Sync 3D Reticle
                reticle.position.set(p.x, p.y, p.z);
                reticle.quaternion.set(r.x, r.y, r.z, r.w);

                if (planeIndicator) {
                    planeIndicator.position.set(p.x, p.y + 0.002, p.z);
                }

                // Smoothly adapt shadow plane to floor elevation
                if (shadowPlane) {
                    shadowPlane.position.y = p.y - 0.001;
                }

                if (!surfaceLocked) {
                    surfaceLocked = true;
                    cssReticle.classList.add('locked');
                    if (planeIndicator) planeIndicator.visible = true;
                    updatePlacementAvailability(true);
                }
            } else {
                missStreak++;
                if (missStreak > MISS_TOLERANCE_FRAMES && surfaceLocked) {
                    surfaceLocked = false;
                    cssReticle.classList.remove('locked');
                    if (planeIndicator) planeIndicator.visible = false;
                    updatePlacementAvailability(false);
                }
            }

            if (selectedPlacedEntry && selectionBoxHelper.visible) {
                selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
            }
        }
    };
};

// Initialize Keyless 8th Wall Engine
const initAR = () => {
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
    initAR();
} else {
    window.addEventListener('xrloaded', initAR);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. MULTI-OBJECT SPAWNING, POSITIONING & DISPOSAL
// ─────────────────────────────────────────────────────────────────────────────

function deepCloneGLTF(source) {
    const clone = source.clone(true);
    clone.traverse((node) => {
        if (node.isMesh) {
            if (node.geometry) node.geometry = node.geometry.clone();
            if (Array.isArray(node.material)) {
                node.material = node.material.map((m) => m.clone());
            } else if (node.material) {
                node.material = node.material.clone();
            }
        }
    });
    return clone;
}

function spawnModelAtReticle(modelData) {
    if (!surfaceLocked || !modelData?.glbUrl) return;

    cssReticle.classList.add('flash');
    setTimeout(() => cssReticle.classList.remove('flash'), 200);

    const targetPos = reticle.position.clone();
    const targetQuat = reticle.quaternion.clone();

    const templatePromise = modelCache[modelData.glbUrl] || preloadModel(modelData.glbUrl, { priority: true });

    templatePromise
        .then((template) => {
            const modelRoot = deepCloneGLTF(template);

            const wrapper = new THREE.Group();
            wrapper.add(modelRoot);

            // Compute exact Bounding Box and offset pivot point to bottom-center
            const box = new THREE.Box3().setFromObject(modelRoot);
            if (!box.isEmpty()) {
                const center = box.getCenter(new THREE.Vector3());
                modelRoot.position.x -= center.x;
                modelRoot.position.z -= center.z;
                modelRoot.position.y -= box.min.y;
            }

            wrapper.position.copy(targetPos);
            const euler = new THREE.Euler().setFromQuaternion(targetQuat, 'YXZ');
            wrapper.rotation.y = euler.y;

            modelRoot.traverse((node) => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                }
            });

            scene.add(wrapper);

            const entry = { mesh: wrapper, price: modelData.price, glbUrl: modelData.glbUrl };
            spawnedModels.push(entry);

            if (spawnedModels.length === 1) {
                hintEl.classList.remove('show-hint');
            }

            setSelectedPlacedModel(entry);
            updateBudget();
        })
        .catch((err) => console.error('[Spawn Error]', err));
}

function selectModelAtTouch(clientX, clientY) {
    if (!camera || !scene || spawnedModels.length === 0) return;

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const meshes = spawnedModels.map((item) => item.mesh);
    const intersects = raycaster.intersectObjects(meshes, true);

    if (intersects.length > 0) {
        let topObj = intersects[0].object;
        while (topObj.parent && topObj.parent !== scene) {
            topObj = topObj.parent;
        }
        const matched = spawnedModels.find((e) => e.mesh === topObj);
        if (matched) {
            setSelectedPlacedModel(matched);
            return;
        }
    }

    setSelectedPlacedModel(null);
}

function dragSelectedModel(clientX, clientY) {
    if (!selectedPlacedEntry || !window.XR8 || !window.XR8.XrController) return;

    const nx = clientX / window.innerWidth;
    const ny = clientY / window.innerHeight;

    const hits = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
    const groundHit = findFastGroundHit(hits);

    if (groundHit) {
        selectedPlacedEntry.mesh.position.set(groundHit.position.x, groundHit.position.y, groundHit.position.z);
        if (selectionBoxHelper.visible) {
            selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
        }
    }
}

function setSelectedPlacedModel(entry) {
    selectedPlacedEntry = entry;
    if (entry) {
        selectionBoxHelper.setFromObject(entry.mesh);
        selectionBoxHelper.visible = true;
        deleteBtn.style.display = 'inline-flex';
    } else {
        selectionBoxHelper.visible = false;
        deleteBtn.style.display = 'none';
    }
}

function disposeMeshHierarchy(meshGroup) {
    meshGroup.traverse((node) => {
        if (node.isMesh) {
            node.geometry?.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach((m) => m?.dispose());
            } else if (node.material) {
                node.material?.dispose();
            }
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UI CONTROL CONTROLLER & BUDGET TALLY
// ─────────────────────────────────────────────────────────────────────────────

function updateBudget() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    document.getElementById('budget-value').textContent = `$${total.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

function updatePlacementAvailability(isReady) {
    placeBtn.disabled = !isReady;
    placeBtn.style.opacity = isReady ? '1' : '0.4';
    placeBtn.style.pointerEvents = isReady ? 'auto' : 'none';

    if (selectedModelData) {
        hintEl.textContent = isReady ? READY_HINT : SCANNING_HINT;
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

placeBtn.addEventListener('click', () => {
    if (selectedModelData && surfaceLocked) {
        spawnModelAtReticle(selectedModelData);
    }
});

deleteBtn.addEventListener('click', () => {
    if (!selectedPlacedEntry) return;

    const toDelete = selectedPlacedEntry;
    setSelectedPlacedModel(null);

    scene.remove(toDelete.mesh);
    disposeMeshHierarchy(toDelete.mesh);

    const idx = spawnedModels.indexOf(toDelete);
    if (idx !== -1) {
        spawnedModels.splice(idx, 1);
    }
    updateBudget();
});

document.getElementById('clear-btn').addEventListener('click', () => {
    setSelectedPlacedModel(null);
    spawnedModels.forEach((entry) => {
        scene.remove(entry.mesh);
        disposeMeshHierarchy(entry.mesh);
    });
    spawnedModels.length = 0;
    updateBudget();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. FIREBASE REALTIME CATALOG INTEGRATION
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
    document.querySelectorAll('.catalog-item').forEach((el) => el.classList.remove('selected'));
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
                    title: d.title ?? 'Unnamed Asset',
                    glbName: d.glb,
                    imgName: d.img ?? null,
                    price: d.price ?? 349.00,
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