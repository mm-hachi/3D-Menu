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
let selectionBoxHelper;

const spawnedModels = []; // [{ mesh, price, glbUrl }]
let selectedModelData = null; // Catalog asset data: { glbUrl, price }
let selectedPlacedEntry = null; // Placed 3D object: { mesh, price, glbUrl }

// Enable Three.js network cache
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
let hasHitSurface = false;

const MISS_TOLERANCE_FRAMES = 6;
const FEATURE_POINT_SETTLE_FRAMES = 10;
let missStreak = 0;
let hitStreak = 0;
let surfaceLocked = false;
const SCANNING_HINT = 'Move your device slowly to scan for a surface…';
const DETECTING_HINT = 'Hold steady, locking onto surface…';
const READY_HINT = "Aim at a surface and tap 'Place Model'";

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLACED MODEL SELECTION & MANIPULATION
// ─────────────────────────────────────────────────────────────────────────────

function selectPlacedModel(entry) {
    selectedPlacedEntry = entry;
    const deleteBtn = document.getElementById('delete-selected-btn');

    if (entry) {
        // Enforce true 1:1 scale and lock Z rotation on selection
        entry.mesh.scale.set(1, 1, 1);
        entry.mesh.rotation.z = 0;
        entry.mesh.rotation.x = 0;

        selectionBoxHelper.setFromObject(entry.mesh);
        selectionBoxHelper.visible = true;
        deleteBtn.style.display = 'inline-flex';
    } else {
        selectionBoxHelper.visible = false;
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

// ─────────────────────────────────────────────────────────────────────────────
// 3. 8TH WALL PIPELINE LOGIC
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    let touchStartX = 0;
    let touchStartY = 0;
    let isTouching = false;
    let previousTwoTouchAngle = null;

    return {
        name: 'ar-staging-logic',
        onStart: ({ canvas }) => {
            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            if (renderer && renderer.setPixelRatio) {
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            }

            const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
            light.position.set(0.5, 1, 0.25);
            scene.add(light);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
            dirLight.position.set(1, 4, 2);
            scene.add(dirLight);

            reticle = new THREE.Object3D();
            scene.add(reticle);

            selectionBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x007aff);
            selectionBoxHelper.visible = false;
            scene.add(selectionBoxHelper);

            // Pointer & Touch Listeners for Move, Rotate, and Selection
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    isTouching = true;
                } else if (e.touches.length === 2 && selectedPlacedEntry) {
                    const dx = e.touches[1].clientX - e.touches[0].clientX;
                    const dy = e.touches[1].clientY - e.touches[0].clientY;
                    previousTwoTouchAngle = Math.atan2(dy, dx);
                }
            }, { passive: true });

            canvas.addEventListener('touchmove', (e) => {
                if (!selectedPlacedEntry) return;

                if (e.touches.length === 1 && isTouching) {
                    // 1-Finger Touch Drag: Move selected model directly along scanned surface
                    const currentX = e.touches[0].clientX;
                    const currentY = e.touches[0].clientY;

                    const normX = currentX / window.innerWidth;
                    const normY = currentY / window.innerHeight;
                    const hitResults = XR8.XrController.hitTest(normX, normY, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
                    const hit = hitResults?.find(h => h.type === 'ESTIMATED_SURFACE_PLANE') || hitResults?.find(h => h.type === 'FEATURE_POINT');

                    if (hit) {
                        selectedPlacedEntry.mesh.position.set(hit.position.x, hit.position.y, hit.position.z);
                    } else if (reticle) {
                        selectedPlacedEntry.mesh.position.copy(reticle.position);
                    }

                    // Enforce scale & Z-rotation lock
                    selectedPlacedEntry.mesh.scale.set(1, 1, 1);
                    selectedPlacedEntry.mesh.rotation.z = 0;
                    selectedPlacedEntry.mesh.rotation.x = 0;
                } else if (e.touches.length === 2) {
                    // 2-Finger Touch Twist: Rotate model around Y-axis (lock Z-axis)
                    const dx = e.touches[1].clientX - e.touches[0].clientX;
                    const dy = e.touches[1].clientY - e.touches[0].clientY;
                    const currentAngle = Math.atan2(dy, dx);

                    if (previousTwoTouchAngle !== null) {
                        const deltaAngle = currentAngle - previousTwoTouchAngle;
                        selectedPlacedEntry.mesh.rotation.y += deltaAngle;
                        selectedPlacedEntry.mesh.rotation.z = 0;
                        selectedPlacedEntry.mesh.rotation.x = 0;
                    }
                    previousTwoTouchAngle = currentAngle;
                }
            }, { passive: true });

            canvas.addEventListener('touchend', (e) => {
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;
                    isTouching = false;

                    if (Math.hypot(endX - touchStartX, endY - touchStartY) < 10) {
                        handleCanvasTap(endX, endY);
                    }
                }
                if (e.touches.length < 2) {
                    previousTwoTouchAngle = null;
                }
            });

            // Desktop Mouse Wheel Fallback for Rotation
            canvas.addEventListener('wheel', (e) => {
                if (selectedPlacedEntry) {
                    selectedPlacedEntry.mesh.rotation.y += e.deltaY * 0.005;
                    selectedPlacedEntry.mesh.rotation.z = 0;
                    selectedPlacedEntry.mesh.rotation.x = 0;
                }
            }, { passive: true });

            canvas.addEventListener('click', (e) => {
                handleCanvasTap(e.clientX, e.clientY);
            });

            updatePlacementAvailability(false);
        },
        onUpdate: () => {
            if (!scene) return;

            const hitTestResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
            const planeHit = hitTestResults?.find((hit) => hit.type === 'ESTIMATED_SURFACE_PLANE');
            const featureHit = hitTestResults?.find((hit) => hit.type === 'FEATURE_POINT');
            const hit = planeHit || featureHit;

            if (hit) {
                missStreak = 0;
                hitStreak = planeHit ? FEATURE_POINT_SETTLE_FRAMES : Math.min(hitStreak + 1, FEATURE_POINT_SETTLE_FRAMES);

                const p = hit.position;
                const r = hit.rotation;
                reticle.position.set(p.x, p.y, p.z);
                reticle.quaternion.set(r.x, r.y, r.z, r.w);

                const isSettled = hitStreak >= FEATURE_POINT_SETTLE_FRAMES;

                cssReticle.style.display = 'flex';
                cssReticle.style.opacity = isSettled ? '1' : '0.5';

                if (isSettled) {
                    hasHitSurface = true;
                    if (!surfaceLocked) {
                        surfaceLocked = true;
                        updatePlacementAvailability(true);
                    }
                } else if (selectedModelData) {
                    hintEl.textContent = DETECTING_HINT;
                }
            } else {
                missStreak += 1;
                hitStreak = Math.max(0, hitStreak - 1);

                if (missStreak > MISS_TOLERANCE_FRAMES) {
                    cssReticle.style.opacity = hasHitSurface ? '0.35' : '0';

                    if (surfaceLocked) {
                        surfaceLocked = false;
                        updatePlacementAvailability(false);
                    }
                }
            }

            // Keep selected model strictly locked at 1:1 scale, locked Z rotation, and aligned selection box
            if (selectedPlacedEntry) {
                selectedPlacedEntry.mesh.scale.set(1, 1, 1);
                selectedPlacedEntry.mesh.rotation.z = 0;
                selectedPlacedEntry.mesh.rotation.x = 0;

                if (selectionBoxHelper.visible) {
                    selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
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
    spawnedModels.forEach(entry => scene.remove(entry.mesh));
    spawnedModels.length = 0;
    updateBudget();
});

document.getElementById('delete-selected-btn').addEventListener('click', () => {
    if (!selectedPlacedEntry) return;

    const entryToDelete = selectedPlacedEntry;
    selectPlacedModel(null);

    scene.remove(entryToDelete.mesh);
    entryToDelete.mesh.traverse((node) => {
        if (node.isMesh) {
            node.geometry?.dispose();
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            mats.forEach(m => m?.dispose());
        }
    });

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

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;

    cssReticle.classList.add('flash');
    setTimeout(() => cssReticle.classList.remove('flash'), 200);

    const placementPosition = reticle.position.clone();
    const placementQuaternion = reticle.quaternion.clone();

    const templatePromise = modelCache[glbUrl] || preloadModel(glbUrl, { priority: true });

    templatePromise
        .then((template) => addMeshToScene(template.clone(), modelData, placementPosition, placementQuaternion))
        .catch((err) => console.error('[spawnModel] Load error:', err));
}

function addMeshToScene(mesh, modelData, placementPosition, placementQuaternion) {
    // Lock model to 1:1 true scale
    mesh.scale.set(1, 1, 1);

    // Force model position directly to focus point / reticle location
    const targetPos = placementPosition || reticle.position;
    mesh.position.copy(targetPos);

    // Extract Y-axis rotation only, locking Z and X rotation
    const euler = new THREE.Euler().setFromQuaternion(placementQuaternion || reticle.quaternion, 'YXZ');
    mesh.rotation.set(0, euler.y, 0);

    scene.add(mesh);
    const entry = { mesh, price: modelData.price, glbUrl: modelData.glbUrl };
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