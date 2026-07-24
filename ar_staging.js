import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Expose THREE globally for 8th Wall's pipeline
window.THREE = THREE;

// 1. FIREBASE INITIALIZATION 
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

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

// 2. STATE & CACHE MANAGEMENT
let scene, camera, renderer;
let reticle3D, shadowPlane, selectionBox;
const spawnedModels = [];
let activeCatalogAsset = null;
let selectedSceneModel = null;
let isGroundLocked = false;

// Caching system for instant multi-placement
const modelCache = new Map();
const dracoLoader = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader().setDRACOLoader(dracoLoader);

// 3. UI DOM ELEMENTS
const domReticle = document.getElementById('reticle');
const hintEl = document.getElementById('placement-hint');
const placeBtn = document.getElementById('place-btn');
const deleteBtn = document.getElementById('delete-selected-btn');
const budgetValue = document.getElementById('budget-value');
const drawer = document.getElementById('catalog-drawer');

// 4. CATALOG REGISTRY & FIRESTORE SYNC
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
    activeCatalogAsset = assetData;

    if (isGroundLocked) {
        placeBtn.style.display = 'inline-flex';
    }
    hintEl.classList.add('show-hint');
}

function renderCatalog(category) {
    const list = document.getElementById('catalog-list');
    if (!list) return;
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

                preloadAsset(glbUrl);

                card.addEventListener('click', () => {
                    selectCatalogModel(card, assetData);
                    preloadAsset(glbUrl);
                });

                if (!activeCatalogAsset && isFirstCard) {
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

// 5. STRICT GROUND DETECTION
function isRealGroundPlane(hitRotation) {
    if (!hitRotation) return false;
    const quaternion = new THREE.Quaternion(hitRotation.x, hitRotation.y, hitRotation.z, hitRotation.w);
    const upVector = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    return Math.abs(upVector.dot(new THREE.Vector3(0, 1, 0))) > 0.85;
}

// 6. 8TH WALL AR PIPELINE MODULE
const spatialStagingPipeline = () => {
    let touchStartX, touchStartY;
    const raycaster = new THREE.Raycaster();
    const tapVector = new THREE.Vector2();

    return {
        name: 'xlvii-spatial-staging',
        onStart: ({ canvas }) => {
            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            const ambientLight = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.2);
            scene.add(ambientLight);

            const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
            directionalLight.position.set(5, 10, 7);
            directionalLight.castShadow = true;
            directionalLight.shadow.mapSize.set(1024, 1024);
            scene.add(directionalLight);

            shadowPlane = new THREE.Mesh(
                new THREE.PlaneGeometry(50, 50),
                new THREE.ShadowMaterial({ opacity: 0.4 })
            );
            shadowPlane.rotation.x = -Math.PI / 2;
            shadowPlane.receiveShadow = true;
            scene.add(shadowPlane);

            reticle3D = new THREE.Object3D();
            scene.add(reticle3D);

            selectionBox = new THREE.BoxHelper(new THREE.Mesh(), 0x34c759);
            selectionBox.visible = false;
            scene.add(selectionBox);

            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                }
            });

            canvas.addEventListener('touchend', (e) => {
                if (e.changedTouches.length !== 1) return;
                const dist = Math.hypot(e.changedTouches[0].clientX - touchStartX, e.changedTouches[0].clientY - touchStartY);

                if (dist < 10) {
                    tapVector.x = (e.changedTouches[0].clientX / window.innerWidth) * 2 - 1;
                    tapVector.y = -(e.changedTouches[0].clientY / window.innerHeight) * 2 + 1;
                    raycaster.setFromCamera(tapVector, camera);

                    const intersects = raycaster.intersectObjects(spawnedModels.map(m => m.mesh), true);
                    if (intersects.length > 0) {
                        let object = intersects[0].object;
                        while (object.parent && object.parent !== scene) {
                            object = object.parent;
                        }
                        selectModelInScene(spawnedModels.find(m => m.mesh === object));
                    } else {
                        selectModelInScene(null);
                    }
                }
            });
        },

        onUpdate: () => {
            if (!scene || !XR8.XrController) return;

            const hits = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE']);
            let validGround = null;

            for (const hit of hits) {
                if (hit.type === 'ESTIMATED_SURFACE_PLANE' && isRealGroundPlane(hit.rotation)) {
                    validGround = hit;
                    break;
                }
            }

            if (validGround) {
                reticle3D.position.copy(validGround.position);
                reticle3D.quaternion.copy(validGround.rotation);
                shadowPlane.position.y = validGround.position.y;

                if (!isGroundLocked) {
                    isGroundLocked = true;
                    domReticle?.classList.add('locked');
                    if (activeCatalogAsset && placeBtn) placeBtn.style.display = 'inline-flex';
                    if (hintEl) hintEl.textContent = "Surface detected. Tap to place.";
                }
            } else {
                if (isGroundLocked) {
                    isGroundLocked = false;
                    domReticle?.classList.remove('locked');
                    if (placeBtn) placeBtn.style.display = 'none';
                    if (hintEl) hintEl.textContent = "Scanning for floor...";
                }
            }

            if (selectedSceneModel && selectionBox.visible) {
                selectionBox.setFromObject(selectedSceneModel.mesh);
            }
        }
    };
};

// Initialize 8th Wall
const initAR = () => {
    XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),
        XR8.Threejs.pipelineModule(),
        XR8.XrController.pipelineModule(),
        window.XRExtras.AlmostThere.pipelineModule(),
        window.XRExtras.FullWindowCanvas.pipelineModule(),
        window.XRExtras.Loading.pipelineModule(),
        spatialStagingPipeline(),
    ]);
    XR8.run({ canvas: document.getElementById('camera-canvas') });
};

if (window.XR8) {
    initAR();
} else {
    window.addEventListener('xrloaded', initAR);
}

// 7. ASSET PLACEMENT & MEMORY MANAGEMENT
function preloadAsset(glbUrl) {
    if (!glbUrl || modelCache.has(glbUrl)) return;
    gltfLoader.load(glbUrl, (gltf) => {
        modelCache.set(glbUrl, gltf.scene);
    });
}

function spawnAsset() {
    if (!isGroundLocked || !activeCatalogAsset) return;

    domReticle?.classList.add('flash');
    setTimeout(() => domReticle?.classList.remove('flash'), 150);

    const template = modelCache.get(activeCatalogAsset.glbUrl);
    if (!template) {
        console.warn("Asset still loading into memory...");
        return;
    }

    const clone = template.clone(true);
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    clone.position.set(-center.x, -box.min.y, -center.z);

    const wrapper = new THREE.Group();
    wrapper.add(clone);
    wrapper.position.copy(reticle3D.position);

    const euler = new THREE.Euler().setFromQuaternion(reticle3D.quaternion, 'YXZ');
    wrapper.rotation.y = euler.y;

    wrapper.traverse((node) => {
        if (node.isMesh) {
            node.castShadow = true;
            node.receiveShadow = true;
        }
    });

    scene.add(wrapper);
    spawnedModels.push({
        mesh: wrapper,
        price: activeCatalogAsset.price
    });

    updateTally();
}

// 8. INTERACTIVITY & DRAWER LOGIC
placeBtn?.addEventListener('click', spawnAsset);

function selectModelInScene(modelRecord) {
    selectedSceneModel = modelRecord;
    if (modelRecord) {
        selectionBox.setFromObject(modelRecord.mesh);
        selectionBox.visible = true;
        if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
        selectionBox.visible = false;
        if (deleteBtn) deleteBtn.style.display = 'none';
    }
}

deleteBtn?.addEventListener('click', () => {
    if (!selectedSceneModel) return;

    scene.remove(selectedSceneModel.mesh);
    spawnedModels.splice(spawnedModels.indexOf(selectedSceneModel), 1);

    selectModelInScene(null);
    updateTally();
});

document.getElementById('clear-btn')?.addEventListener('click', () => {
    spawnedModels.forEach(m => scene.remove(m.mesh));
    spawnedModels.length = 0;
    selectModelInScene(null);
    updateTally();
});

function updateTally() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    if (budgetValue) budgetValue.textContent = `$${total.toFixed(2)}`;
}

document.getElementById('hamburger-btn')?.addEventListener('click', () => drawer?.classList.remove('collapsed'));
document.getElementById('close-drawer-btn')?.addEventListener('click', () => drawer?.classList.add('collapsed'));