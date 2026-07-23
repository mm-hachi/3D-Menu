import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

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

// Background preload queue for instant placement
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

// Reticle Setup
const reticleGeo = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({ color: 0x34c759 });

// Raycasting for Model Selection
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLACED MODEL SELECTION & HIGHLIGHTING
// ─────────────────────────────────────────────────────────────────────────────

function selectPlacedModel(entry) {
    selectedPlacedEntry = entry;
    const deleteBtn = document.getElementById('delete-selected-btn');

    if (entry) {
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

    // Tapped open space -> deselect placed model
    selectPlacedModel(null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 8TH WALL PIPELINE LOGIC (SLAM ENGINE)
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    let touchStartX = 0;
    let touchStartY = 0;

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

            // Scene Lighting
            const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
            light.position.set(0.5, 1, 0.25);
            scene.add(light);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
            dirLight.position.set(1, 4, 2);
            scene.add(dirLight);

            // Add reticle
            reticle = new THREE.Mesh(reticleGeo, reticleMat);
            reticle.matrixAutoUpdate = false;
            reticle.visible = false;
            scene.add(reticle);

            // Add selection box helper for highlighting 3D models
            selectionBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x007aff);
            selectionBoxHelper.visible = false;
            scene.add(selectionBoxHelper);

            // Pointer/Touch Listeners for selection & tap-to-place
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                }
            }, { passive: true });

            canvas.addEventListener('touchend', (e) => {
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;

                    // Only count as a tap if touch didn't drag significantly
                    if (Math.hypot(endX - touchStartX, endY - touchStartY) < 10) {
                        handleCanvasTap(endX, endY);
                    }
                }
            });

            canvas.addEventListener('click', (e) => {
                // Desktop / Mouse fallback
                handleCanvasTap(e.clientX, e.clientY);
            });
        },
        onUpdate: () => {
            if (!scene) return;

            // Perform hit test straight out from viewport center (0.5, 0.5)
            const hitTestResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);

            if (hitTestResults && hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                reticle.visible = true;

                const p = hit.position;
                const r = hit.rotation;
                const quaternion = new THREE.Quaternion(r.x, r.y, r.z, r.w);

                reticle.matrix.compose(
                    new THREE.Vector3(p.x, p.y, p.z),
                    quaternion,
                    new THREE.Vector3(1, 1, 1)
                );
            } else {
                reticle.visible = false;
            }

            // Keep selection bounding box aligned with selected object
            if (selectedPlacedEntry && selectionBoxHelper.visible) {
                selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
            }
        }
    };
};

const onxrloaded = () => {
    XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),       // Camera feed renderer
        XR8.Threejs.pipelineModule(),                 // Three.js sync
        XR8.XrController.pipelineModule(),            // SLAM tracking engine
        window.XRExtras.AlmostThere.pipelineModule(), // Loading UI
        window.XRExtras.FullWindowCanvas.pipelineModule(),
        window.XRExtras.Loading.pipelineModule(),
        window.XRExtras.RuntimeError.pipelineModule(),
        arStagingPipelineModule(),                    // App Logic
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

// Hamburger Drawer Toggle
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

// Clear All Models
document.getElementById('clear-btn').addEventListener('click', () => {
    selectPlacedModel(null);
    spawnedModels.forEach(entry => scene.remove(entry.mesh));
    spawnedModels.length = 0;
    updateBudget();
});

// Dynamic Delete Button Action
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

// Dynamic Place Button Action
const placeBtn = document.getElementById('place-btn');
placeBtn.addEventListener('click', () => {
    if (reticle.visible && selectedModelData) {
        spawnModelAtReticle(selectedModelData);
    }
});

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;

    // Visual reticle flash feedback
    reticleMat.color.setHex(0xffffff);
    setTimeout(() => reticleMat.color.setHex(0x34c759), 200);

    const placementMatrix = reticle.matrix.clone();
    const templatePromise = modelCache[glbUrl] || preloadModel(glbUrl, { priority: true });

    templatePromise
        .then((template) => addMeshToScene(template.clone(), modelData, placementMatrix))
        .catch((err) => console.error('[spawnModel] Load error:', err));
}

function addMeshToScene(mesh, modelData, placementMatrix) {
    const matrix = placementMatrix || reticle.matrix;
    mesh.position.setFromMatrixPosition(matrix);

    const euler = new THREE.Euler().setFromRotationMatrix(matrix, 'YXZ');
    mesh.rotation.y = euler.y;

    scene.add(mesh);
    const entry = { mesh, price: modelData.price, glbUrl: modelData.glbUrl };
    spawnedModels.push(entry);

    // Automatically select newly placed model
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

    // Show place button & placement guidance hint
    placeBtn.style.display = 'inline-flex';
    document.getElementById('placement-hint').classList.add('show-hint');
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
