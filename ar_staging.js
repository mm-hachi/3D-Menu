import * as THREE from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { ARButton }    from 'three/addons/webxr/ARButton.js';

import { initializeApp }   from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCENE SETUP
// ─────────────────────────────────────────────────────────────────────────────

const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
light.position.set(0.5, 1, 0.25);
scene.add(light);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(1, 4, 2);
scene.add(dirLight);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

// ─────────────────────────────────────────────────────────────────────────────
// 2. WEBXR ARBUTTON & HIT TEST SETUP
// ─────────────────────────────────────────────────────────────────────────────

const overlayElement = document.getElementById('ar-overlay');
const arButton = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: overlayElement }
});
document.getElementById('ar-button-container').appendChild(arButton);

renderer.xr.addEventListener('sessionstart', () => {
    document.getElementById('startup-screen').style.display = 'none';
    overlayElement.style.display = 'block';
});

renderer.xr.addEventListener('sessionend', () => {
    document.getElementById('startup-screen').style.display = 'flex';
    overlayElement.style.display = 'none';
});

// Reticle
const reticleGeo = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
const reticleMat = new THREE.MeshBasicMaterial({ color: 0x34c759 });
const reticle = new THREE.Mesh(reticleGeo, reticleMat);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

let hitTestSource = null;
let hitTestSourceRequested = false;

// ─────────────────────────────────────────────────────────────────────────────
// 3. LOADERS & STATE
// ─────────────────────────────────────────────────────────────────────────────

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const modelCache = {};
const spawnedModels = [];
let selectedModelData = null; // { glbUrl, price }

// Update UI
function updateBudget() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    document.getElementById('budget-value').textContent = `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

document.getElementById('clear-btn').addEventListener('click', () => {
    spawnedModels.forEach(entry => scene.remove(entry.mesh));
    spawnedModels.length = 0;
    updateBudget();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PLACEMENT LOGIC
// ─────────────────────────────────────────────────────────────────────────────

const controller = renderer.xr.getController(0);
controller.addEventListener('select', onSelect);
scene.add(controller);

function onSelect() {
    if (reticle.visible && selectedModelData) {
        spawnModelAtReticle(selectedModelData);
    }
}

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;
    
    // Add visual feedback
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
    
    // WebXR sets reticle matrix based on surface normal.
    // For floors, Y is up, but we want the object to face the camera.
    // However, keeping reticle's quaternion aligns with the surface perfectly.
    // To simplify and ensure upright models, we just extract the Y rotation.
    
    const euler = new THREE.Euler().setFromRotationMatrix(reticle.matrix, 'YXZ');
    mesh.rotation.y = euler.y;

    scene.add(mesh);
    spawnedModels.push({ mesh, price: modelData.price });
    updateBudget();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FIREBASE CATALOG
// ─────────────────────────────────────────────────────────────────────────────

const firebaseConfig = {
    apiKey:            'AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY',
    authDomain:        'shot47-database.firebaseapp.com',
    projectId:         'shot47-database',
    storageBucket:     'shot47-database.firebasestorage.app',
    messagingSenderId: '77237094269',
    appId:             '1:77237094269:web:a90a6c6239cb66e3102e14',
};

const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);
const storage     = getStorage(firebaseApp);

const registry = { furniture: [], carpets: [], decor: [] };
let activeCategory = 'furniture';

const collectionMap = {
    furniture: 'furniture_models',
    carpets:   'carpet_models',
    decor:     'decor_models',
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

    const hint = document.getElementById('placement-hint');
    hint.classList.add('show-hint');
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
                .catch(() => {});
        }

        resolveUrl(asset.glbName, 'models/glb')
            .then((glbUrl) => {
                card.classList.remove('state-loading');
                const assetData = { glbUrl, price: asset.price };
                
                card.addEventListener('click', () => selectModel(card, assetData));
                
                // If it's the very first item and nothing is selected, pre-select it
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
                    title:   d.title ?? 'Unnamed',
                    glbName: d.glb,
                    imgName: d.img ?? null,
                    price:   d.price ?? 349.00
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

// ─────────────────────────────────────────────────────────────────────────────
// 6. RENDER LOOP
// ─────────────────────────────────────────────────────────────────────────────

function render(timestamp, frame) {
    if (frame) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        const session = renderer.xr.getSession();

        if (hitTestSourceRequested === false) {
            session.requestReferenceSpace('viewer').then((refSpace) => {
                session.requestHitTestSource({ space: refSpace }).then((source) => {
                    hitTestSource = source;
                });
            });
            session.addEventListener('end', () => {
                hitTestSourceRequested = false;
                hitTestSource = null;
            });
            hitTestSourceRequested = true;
        }

        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);
                reticle.visible = true;
                reticle.matrix.fromArray(pose.transform.matrix);
            } else {
                reticle.visible = false;
            }
        }
    }
    renderer.render(scene, camera);
}

renderer.setAnimationLoop(render);

// Resize handler
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
