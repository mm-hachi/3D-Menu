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
const spawnedModels = [];
let selectedModelData = null; // { glbUrl, price }

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
const modelCache = {};

// Reticle
const reticleGeo = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({ color: 0x34c759 });

// ─────────────────────────────────────────────────────────────────────────────
// 2. 8TH WALL PIPELINE LOGIC (SLAM ENGINE)
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    return {
        name: 'ar-staging-logic',
        onStart: ({ canvas }) => {
            // 8th Wall automatically sets up a Three.js scene overlaying the camera feed.
            // We just grab the references to it here.
            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            // Enhance lighting for AR
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

            // Tap-to-place event
            // Note: The UI has 'pointer-events: auto', so touches on the UI won't trigger this canvas event!
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1 && reticle.visible && selectedModelData) {
                    spawnModelAtReticle(selectedModelData);
                }
            });
        },
        onUpdate: () => {
            if (!scene) return;

            // Perform a hit test straight out from the center of the screen
            // '0.5, 0.5' represents the center of the viewport in normalized coordinates.
            const hitTestResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);

            if (hitTestResults && hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                reticle.visible = true;

                // 8th Wall provides position and rotation natively.
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
        }
    };
};

const onxrloaded = () => {
    // Register the 8th Wall modules.
    XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),       // Draws camera feed
        XR8.Threejs.pipelineModule(),                 // Syncs camera with Three.js
        XR8.XrController.pipelineModule(),            // Core SLAM tracking
        window.XRExtras.AlmostThere.pipelineModule(), // Loading UI
        window.XRExtras.FullWindowCanvas.pipelineModule(),
        window.XRExtras.Loading.pipelineModule(),
        window.XRExtras.RuntimeError.pipelineModule(),
        arStagingPipelineModule(),                    // Our custom App Logic
    ]);

    // Launch!
    XR8.run({ canvas: document.getElementById('camera-canvas') });
};

// Wait for 8th Wall scripts to load
if (window.XR8) {
    onxrloaded();
} else {
    window.addEventListener('xrloaded', onxrloaded);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. UI & PLACEMENT LOGIC
// ─────────────────────────────────────────────────────────────────────────────

function updateBudget() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    document.getElementById('budget-value').textContent = `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

document.getElementById('clear-btn').addEventListener('click', () => {
    spawnedModels.forEach(entry => scene.remove(entry.mesh));
    spawnedModels.length = 0;
    updateBudget();
});

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;

    // Visual feedback
    reticleMat.color.setHex(0xffffff);
    setTimeout(() => reticleMat.color.setHex(0x34c759), 200);

    if (modelCache[glbUrl]) {
        addMeshToScene(modelCache[glbUrl].clone(), modelData);
    } else {
        gltfLoader.load(
            glbUrl,
            (gltf) => {
                const mesh = gltf.scene;
                modelCache[glbUrl] = mesh;
                addMeshToScene(mesh.clone(), modelData);
            },
            undefined,
            (err) => console.error('[spawnModel] Load error:', err)
        );
    }
}

function addMeshToScene(mesh, modelData) {
    mesh.position.setFromMatrixPosition(reticle.matrix);

    // Extract Y rotation to keep the model upright, facing relative to camera
    const euler = new THREE.Euler().setFromRotationMatrix(reticle.matrix, 'YXZ');
    mesh.rotation.y = euler.y;

    scene.add(mesh);
    spawnedModels.push({ mesh, price: modelData.price });
    updateBudget();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. FIREBASE CATALOG
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

function selectModel(card, assetData) {
    document.querySelectorAll('.catalog-item').forEach(el => el.classList.remove('selected'));
    card.classList.add('selected');
    selectedModelData = assetData;
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

                card.addEventListener('click', () => selectModel(card, assetData));

                if (!selectedModelData && list.children[0] === card) {
                    selectModel(card, assetData);
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
