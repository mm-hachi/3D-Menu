import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Expose THREE globally for 8th Wall's pipeline
window.THREE = THREE;

// 1. FIREBASE INITIALIZATION 
// (Retaining your previous logic structure for 47 / XLVII retail staging)
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
const domReticle = document.getElementById('reticle'); //[cite: 11]
const hintEl = document.getElementById('placement-hint'); //[cite: 11]
const placeBtn = document.getElementById('place-btn'); //[cite: 11]
const deleteBtn = document.getElementById('delete-selected-btn'); //[cite: 11]
const budgetValue = document.getElementById('budget-value'); //[cite: 11]

// 4. STRICT GROUND DETECTION
// Ensures the hit test isn't just a random feature point, but a true horizontal surface.
function isRealGroundPlane(hitRotation) {
    if (!hitRotation) return false;
    const quaternion = new THREE.Quaternion(hitRotation.x, hitRotation.y, hitRotation.z, hitRotation.w);
    const upVector = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    // Dot product close to 1 means the plane's normal is pointing straight up
    return Math.abs(upVector.dot(new THREE.Vector3(0, 1, 0))) > 0.85;
}

// 5. 8TH WALL AR PIPELINE MODULE
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

            // Lighting for photorealistic staging
            const ambientLight = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.2);
            scene.add(ambientLight);

            const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
            directionalLight.position.set(5, 10, 7);
            directionalLight.castShadow = true;
            directionalLight.shadow.mapSize.set(1024, 1024);
            scene.add(directionalLight);

            // Invisible shadow catcher on the floor
            shadowPlane = new THREE.Mesh(
                new THREE.PlaneGeometry(50, 50),
                new THREE.ShadowMaterial({ opacity: 0.4 })
            );
            shadowPlane.rotation.x = -Math.PI / 2;
            shadowPlane.receiveShadow = true;
            scene.add(shadowPlane);

            // Invisible 3D reticle to track placement coordinates
            reticle3D = new THREE.Object3D();
            scene.add(reticle3D);

            // Selection box for deleting objects
            selectionBox = new THREE.BoxHelper(new THREE.Mesh(), 0x34c759); // Matches UI green[cite: 10]
            selectionBox.visible = false;
            scene.add(selectionBox);

            // Touch Handling for Selection
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                }
            });

            canvas.addEventListener('touchend', (e) => {
                if (e.changedTouches.length !== 1) return;
                const dist = Math.hypot(e.changedTouches[0].clientX - touchStartX, e.changedTouches[0].clientY - touchStartY);

                // If it's a tap (not a drag)
                if (dist < 10) {
                    tapVector.x = (e.changedTouches[0].clientX / window.innerWidth) * 2 - 1;
                    tapVector.y = -(e.changedTouches[0].clientY / window.innerHeight) * 2 + 1;
                    raycaster.setFromCamera(tapVector, camera);

                    const intersects = raycaster.intersectObjects(spawnedModels.map(m => m.mesh), true);
                    if (intersects.length > 0) {
                        // Find root model
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

            // Strict Hit Test: Only look for estimated surface planes
            const hits = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE']);
            let validGround = null;

            for (const hit of hits) {
                if (hit.type === 'ESTIMATED_SURFACE_PLANE' && isRealGroundPlane(hit.rotation)) {
                    validGround = hit;
                    break;
                }
            }

            if (validGround) {
                // Ground located
                reticle3D.position.copy(validGround.position);
                reticle3D.quaternion.copy(validGround.rotation);
                shadowPlane.position.y = validGround.position.y;

                if (!isGroundLocked) {
                    isGroundLocked = true;
                    domReticle.classList.add('locked'); // Turns reticle green[cite: 10]
                    if (activeCatalogAsset) placeBtn.style.display = 'inline-flex'; //[cite: 11]
                    hintEl.textContent = "Surface detected. Tap to place.";
                }
            } else {
                // Ground lost
                if (isGroundLocked) {
                    isGroundLocked = false;
                    domReticle.classList.remove('locked'); //[cite: 10]
                    placeBtn.style.display = 'none'; //[cite: 11]
                    hintEl.textContent = "Scanning for floor...";
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
    XR8.run({ canvas: document.getElementById('camera-canvas') }); //[cite: 11]
};

if (window.XR8) {
    initAR();
} else {
    window.addEventListener('xrloaded', initAR);
}

// 6. ASSET PLACEMENT & MEMORY MANAGEMENT
function preloadAsset(glbUrl) {
    if (!glbUrl || modelCache.has(glbUrl)) return;
    gltfLoader.load(glbUrl, (gltf) => {
        modelCache.set(glbUrl, gltf.scene);
    });
}

function spawnAsset() {
    if (!isGroundLocked || !activeCatalogAsset) return;

    // Flash the reticle UI[cite: 10]
    domReticle.classList.add('flash');
    setTimeout(() => domReticle.classList.remove('flash'), 150);

    const template = modelCache.get(activeCatalogAsset.glbUrl);
    if (!template) {
        console.warn("Asset still loading into memory...");
        return;
    }

    // Deep clone allows instant multiple placements without re-downloading
    const clone = template.clone(true);

    // Ensure accurate pivot placement
    const box = new THREE.Box3().setFromObject(clone);
    const center = box.getCenter(new THREE.Vector3());
    clone.position.set(-center.x, -box.min.y, -center.z);

    const wrapper = new THREE.Group();
    wrapper.add(clone);
    wrapper.position.copy(reticle3D.position);

    // Align rotation to camera, keeping Y upright
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

// 7. UI INTERACTIVITY
placeBtn.addEventListener('click', spawnAsset); //[cite: 11]

function selectModelInScene(modelRecord) {
    selectedSceneModel = modelRecord;
    if (modelRecord) {
        selectionBox.setFromObject(modelRecord.mesh);
        selectionBox.visible = true;
        deleteBtn.style.display = 'inline-flex'; //[cite: 11]
    } else {
        selectionBox.visible = false;
        deleteBtn.style.display = 'none'; //[cite: 11]
    }
}

deleteBtn.addEventListener('click', () => { //[cite: 11]
    if (!selectedSceneModel) return;

    scene.remove(selectedSceneModel.mesh);
    spawnedModels.splice(spawnedModels.indexOf(selectedSceneModel), 1);

    selectModelInScene(null);
    updateTally();
});

document.getElementById('clear-btn').addEventListener('click', () => { //[cite: 11]
    spawnedModels.forEach(m => scene.remove(m.mesh));
    spawnedModels.length = 0;
    selectModelInScene(null);
    updateTally();
});

function updateTally() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    budgetValue.textContent = `$${total.toFixed(2)}`; //[cite: 11]
}

// 8. DRAWER & CATALOG LOGIC
const drawer = document.getElementById('catalog-drawer'); //[cite: 11]
document.getElementById('hamburger-btn').addEventListener('click', () => drawer.classList.remove('collapsed')); //[cite: 10, 11]
document.getElementById('close-drawer-btn').addEventListener('click', () => drawer.classList.add('collapsed')); //[cite: 10, 11]

function renderCatalog(items) {
    const list = document.getElementById('catalog-list'); //[cite: 11]
    list.innerHTML = '';

    items.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = `catalog-item ${index === 0 ? 'selected' : ''}`; //[cite: 10]
        card.innerHTML = `<div class="card-meta"><span>${item.title}</span></div>`; //[cite: 10]

        list.appendChild(card);

        // Resolve storage URL and cache it immediately
        getDownloadURL(ref(storage, item.glbPath)).then(url => {
            preloadAsset(url);

            if (index === 0 && !activeCatalogAsset) {
                activeCatalogAsset = { glbUrl: url, price: item.price };
            }

            card.addEventListener('click', () => {
                document.querySelectorAll('.catalog-item').forEach(el => el.classList.remove('selected')); //[cite: 10]
                card.classList.add('selected'); //[cite: 10]
                activeCatalogAsset = { glbUrl: url, price: item.price };

                if (isGroundLocked) placeBtn.style.display = 'inline-flex'; //[cite: 11]
                hintEl.classList.add('show-hint'); //[cite: 10]
            });
        });
    });
}

// Example Firebase listener for your categories
onSnapshot(collection(db, 'furniture_models'), (snapshot) => {
    const assets = [];
    snapshot.forEach(doc => assets.push(doc.data()));
    renderCatalog(assets);
});