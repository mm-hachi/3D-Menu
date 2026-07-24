// ============================================================
// AR Retail Staging App
// ------------------------------------------------------------
// This single ES module bootstraps the 8th Wall XR session,
// initializes Firebase, pulls furniture items from Firestore + Storage,
// and lets the user preview and place multiple GLB assets on a
// detected floor plane while rotating them around the vertical axis.
// ============================================================

const THREE = window.THREE;

if (!THREE) {
    throw new Error('Three.js must be loaded before ar_staging.js.');
}

// ------------------------------------------------------------
// DOM references
// ------------------------------------------------------------
const dom = {
    exitBtn: document.getElementById('exitBtn'),
    catalogueBtn: document.getElementById('catalogueBtn'),
    cataloguePanel: document.getElementById('cataloguePanel'),
    closeCatalogue: document.getElementById('closeCatalogue'),
    catalogueList: document.getElementById('catalogueList'),
    scanOverlay: document.getElementById('scanOverlay'),
    loadingScreen: document.getElementById('loadingScreen'),
    permissionOverlay: document.getElementById('permissionOverlay'),
    startARBtn: document.getElementById('startARBtn'),
    placeModelBtn: document.getElementById('placeModelBtn'),
    toast: document.getElementById('toast'),
    placementIndicator: document.getElementById('placementIndicator'),
    canvas: document.getElementById('xr-canvas')
};

// ------------------------------------------------------------
// App state
// ------------------------------------------------------------
const state = {
    initialized: false,
    xrReady: false,
    selectedCatalogItem: null,
    modelCache: new Map(),
    placedModels: [],
    rotation: 0,
    planeY: 0,
    currentGhost: null,
    floorPlane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    raycaster: new THREE.Raycaster(),
    worldPointer: new THREE.Vector2(0, 0),
    lastHitPoint: new THREE.Vector3(),
    camera: null,
    scene: null,
    renderer: null,
    firebaseApp: null,
    firestore: null,
    storage: null,
    storageRef: null,
    firebaseReady: false,
    catalogueItems: [],
    catalogueGroups: []
};

// ------------------------------------------------------------
// Firebase configuration
// ------------------------------------------------------------
const firebaseConfig = {
    apiKey: 'AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY',
    authDomain: 'shot47-database.firebaseapp.com',
    projectId: 'shot47-database',
    storageBucket: 'shot47-database.firebasestorage.app',
    messagingSenderId: '77237094269',
    appId: '1:77237094269:web:a90a6c6239cb66e3102e14'
};

// ------------------------------------------------------------
// Loader helpers
// ------------------------------------------------------------
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${src}"]`);

        if (existing) {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', reject, { once: true });
            return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function importGLTFLoader() {
    const moduleUrl = 'https://unpkg.com/three@0.180.0/examples/jsm/loaders/GLTFLoader.js';
    const { GLTFLoader } = await import(moduleUrl);
    return GLTFLoader;
}

async function initializeFirebase() {
    if (state.firebaseReady) {
        return;
    }

    const firebaseAppModule = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js');
    const firestoreModule = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js');
    const storageModule = await import('https://www.gstatic.com/firebasejs/11.0.1/firebase-storage.js');

    state.firebaseApp = firebaseAppModule.initializeApp(firebaseConfig);
    state.firestore = firestoreModule;
    state.storage = storageModule;
    state.storageRef = storageModule.getStorage(state.firebaseApp);
    state.firebaseReady = true;
}

// ------------------------------------------------------------
// UI helpers
// ------------------------------------------------------------
function showToast(message) {
    dom.toast.textContent = message;
    dom.toast.classList.add('show');

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
        dom.toast.classList.remove('show');
    }, 2500);
}

function setLoading(visible) {
    dom.loadingScreen.style.display = visible ? 'flex' : 'none';
}

function setScanOverlay(visible) {
    dom.scanOverlay.classList.toggle('hidden', !visible);
}

function openCatalogue() {
    dom.cataloguePanel.classList.add('open');
}

function closeCatalogue() {
    dom.cataloguePanel.classList.remove('open');
}

function renderCatalogue(groups) {
    dom.catalogueList.innerHTML = '';

    for (const group of groups) {
        const section = document.createElement('section');
        section.className = 'catalogueGroup';

        const heading = document.createElement('h3');
        heading.textContent = group.label;
        heading.style.marginBottom = '12px';
        heading.style.marginTop = '8px';
        heading.style.fontSize = '15px';
        heading.style.textTransform = 'uppercase';
        heading.style.letterSpacing = '0.04em';
        heading.style.color = '#555';

        section.appendChild(heading);

        for (const item of group.items) {
            const card = document.createElement('article');
            card.className = 'modelCard';
            card.dataset.id = item.id;

            const image = document.createElement('img');
            image.className = 'modelThumb';
            image.alt = item.name;
            image.src = item.thumbnailUrl || '';

            const info = document.createElement('div');
            info.className = 'modelInfo';

            const title = document.createElement('h3');
            title.textContent = item.name;

            const description = document.createElement('p');
            description.textContent = item.description || 'Tap to place this furniture in the room.';

            info.append(title, description);
            card.append(image, info);

            card.addEventListener('click', () => {
                state.selectedCatalogItem = item;
                [...dom.catalogueList.querySelectorAll('.modelCard')].forEach(child => child.classList.remove('selected'));
                card.classList.add('selected');
                dom.placeModelBtn.classList.add('show');
                previewGhost(item);
            });

            section.appendChild(card);
        }

        dom.catalogueList.appendChild(section);
    }
}

// ------------------------------------------------------------
// Firebase catalog loading
// ------------------------------------------------------------
async function fetchCatalogue() {
    await initializeFirebase();

    const categories = [
        { folder: 'furniture_models', label: 'Furniture' },
        { folder: 'carpet_models', label: 'Carpet' },
        { folder: 'decor_models', label: 'Decor' }
    ];

    const groups = [];

    for (const category of categories) {
        const folderRef = state.storage.ref(state.storageRef, category.folder);
        const results = await state.storage.listAll(folderRef);

        const items = await Promise.all(results.items.map(async (itemRef) => {
            const isModelFile = /\.(glb|gltf)$/i.test(itemRef.name);
            if (!isModelFile) {
                return null;
            }

            const modelUrl = await state.storage.getDownloadURL(itemRef);
            const thumbnailName = itemRef.name.replace(/\.(glb|gltf)$/i, '.png');
            let thumbnailUrl = '';

            try {
                const thumbRef = state.storage.ref(state.storageRef, `${category.folder}/${thumbnailName}`);
                thumbnailUrl = await state.storage.getDownloadURL(thumbRef);
            } catch (error) {
                thumbnailUrl = '';
            }

            return {
                id: itemRef.fullPath,
                category: category.folder,
                name: itemRef.name.replace(/\.(glb|gltf)$/i, '').replace(/[_-]+/g, ' '),
                description: `${category.label} model`,
                modelUrl,
                thumbnailUrl
            };
        }));

        const validItems = items.filter(Boolean);
        groups.push({ label: category.label, items: validItems });
    }

    state.catalogueGroups = groups;
    state.catalogueItems = groups.flatMap(group => group.items);
    renderCatalogue(groups);
    showToast(`${state.catalogueItems.length} model items loaded`);
}

// ------------------------------------------------------------
// GLB preview and placement
// ------------------------------------------------------------
async function loadModelAsset(modelUrl) {
    if (state.modelCache.has(modelUrl)) {
        return state.modelCache.get(modelUrl);
    }

    const GLTFLoader = await importGLTFLoader();
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(modelUrl);
    state.modelCache.set(modelUrl, gltf);
    return gltf;
}

function scaleModelToFit(group) {
    const box = new THREE.Box3().setFromObject(group);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z) || 1;
    const target = 0.5;
    const scale = target / maxSize;
    group.scale.setScalar(scale);

    // Normalize the model to the floor plane so it appears grounded.
    const center = new THREE.Vector3();
    box.getCenter(center);
    group.position.sub(center);
    group.position.y = 0;

    return group;
}

async function previewGhost(item) {
    if (!state.scene) {
        return;
    }

    setScanOverlay(false);
    showToast(`Previewing ${item.name}`);

    if (state.currentGhost && state.currentGhost.parent) {
        state.currentGhost.parent.remove(state.currentGhost);
    }

    const gltf = await loadModelAsset(item.modelUrl);
    const ghost = scaleModelToFit(gltf.scene.clone());

    ghost.traverse((child) => {
        if (child.isMesh) {
            child.material = child.material.clone();
            child.material.transparent = true;
            child.material.opacity = 0.72;
        }
    });

    ghost.rotation.set(0, state.rotation, 0);
    state.currentGhost = ghost;
    state.scene.add(ghost);
    updateGhostPosition(state.lastHitPoint || new THREE.Vector3(0, 0, 0));
}

function updateGhostPosition(hitPoint) {
    if (!state.currentGhost) {
        return;
    }

    state.currentGhost.position.copy(hitPoint);
    state.currentGhost.position.y = state.planeY;
    state.currentGhost.rotation.y = state.rotation;
    dom.placementIndicator.style.display = 'block';
}

function resetGhost() {
    if (state.currentGhost && state.currentGhost.parent) {
        state.currentGhost.parent.remove(state.currentGhost);
    }

    state.currentGhost = null;
    dom.placeModelBtn.classList.remove('show');
    dom.placementIndicator.style.display = 'none';
}

function placeSelectedModel() {
    if (!state.selectedCatalogItem || !state.currentGhost) {
        showToast('Choose an item to preview first.');
        return;
    }

    const placed = state.currentGhost.clone(true);
    placed.position.copy(state.currentGhost.position);
    placed.rotation.copy(state.currentGhost.rotation);
    placed.userData = { catalogId: state.selectedCatalogItem.id };

    placed.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material = child.material.clone();
            child.material.transparent = false;
            child.material.opacity = 1;
        }
    });

    state.scene.add(placed);
    state.placedModels.push(placed);
    showToast(`${state.selectedCatalogItem.name} placed`);

    // Keep the ghost mounted for another placement by re-previewing the same item.
    previewGhost(state.selectedCatalogItem);
}

// ------------------------------------------------------------
// 8th Wall XR bootstrap
// ------------------------------------------------------------
async function bootstrapEightWall() {
    if (!window.XR8) {
        await loadScript('https://cdn.8thwall.com/xrweb/8thwall.xrextras.js');
    }

    if (!window.XR8) {
        throw new Error('8th Wall XR8 could not be loaded.');
    }

    const xr8 = window.XR8;

    xr8.addCameraPipelineModule({
        name: 'ar-retail-staging',
        onStart: () => {
            state.xrReady = true;
            showToast('AR system ready');
        },
        onUpdate: () => {
            if (!state.scene || !state.camera) {
                return;
            }

            const hit = computePlaneHit();
            if (hit) {
                state.lastHitPoint.copy(hit);
                state.lastHitPoint.y = state.planeY;
                updateGhostPosition(state.lastHitPoint);
                setScanOverlay(false);
            } else {
                setScanOverlay(true);
            }
        }
    });

    xr8.run({
        canvas: dom.canvas,
        onCreate: ({ scene, camera, renderer }) => {
            state.scene = scene;
            state.camera = camera;
            state.renderer = renderer;
            state.scene.background = null;
            dom.placementIndicator.style.display = 'none';
        }
    });
}

function computePlaneHit() {
    if (!state.camera || !state.scene) {
        return null;
    }

    state.worldPointer.set(0, 0);
    state.raycaster.setFromCamera(state.worldPointer, state.camera);
    const hitPoint = new THREE.Vector3();
    const hit = state.raycaster.ray.intersectPlane(state.floorPlane, hitPoint);

    if (!hit) {
        return null;
    }

    return hitPoint;
}

// ------------------------------------------------------------
// Gesture handling
// ------------------------------------------------------------
let gestureStartAngle = null;
let gestureStartRotation = 0;
const activePointerIds = new Map();

window.addEventListener('pointerdown', (event) => {
    activePointerIds.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointerIds.size === 1) {
        gestureStartAngle = null;
    }
});

window.addEventListener('pointermove', (event) => {
    if (!activePointerIds.has(event.pointerId) || !state.currentGhost) {
        return;
    }

    const current = activePointerIds.get(event.pointerId);
    current.x = event.clientX;
    current.y = event.clientY;

    if (activePointerIds.size >= 2) {
        const points = [...activePointerIds.values()];
        const angle = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);

        if (gestureStartAngle === null) {
            gestureStartAngle = angle;
            gestureStartRotation = state.rotation;
        } else {
            const delta = angle - gestureStartAngle;
            state.rotation = gestureStartRotation + delta;
            state.currentGhost.rotation.y = state.rotation;
        }
    }
});

window.addEventListener('pointerup', (event) => {
    activePointerIds.delete(event.pointerId);
    gestureStartAngle = null;
});

window.addEventListener('wheel', (event) => {
    if (!state.currentGhost) {
        return;
    }

    state.rotation += event.deltaY * 0.003;
    state.currentGhost.rotation.y = state.rotation;
}, { passive: true });

// ------------------------------------------------------------
// UI event wiring
// ------------------------------------------------------------
dom.catalogueBtn.addEventListener('click', openCatalogue);
dom.closeCatalogue.addEventListener('click', closeCatalogue);

dom.exitBtn.addEventListener('click', () => {
    resetGhost();
    showToast('AR session closed');
});

dom.placeModelBtn.addEventListener('click', () => {
    placeSelectedModel();
});

dom.startARBtn.addEventListener('click', async () => {
    try {
        dom.permissionOverlay.style.display = 'none';
        setLoading(true);
        await bootstrapEightWall();
        await fetchCatalogue();
        setLoading(false);
        setScanOverlay(true);
        state.initialized = true;
    } catch (error) {
        console.error(error);
        setLoading(false);
        showToast(error.message || 'AR could not start');
    }
});

// ------------------------------------------------------------
// Kickoff
// ------------------------------------------------------------
(async function init() {
    setLoading(false);
    setScanOverlay(true);

    try {
        await initializeFirebase();
        console.info('Firebase initialized:', state.firebaseApp.name);
    } catch (error) {
        console.warn('Firebase config is missing or invalid:', error);
        showToast('Add a valid Firebase config to window.__FIREBASE_CONFIG__.');
    }
})();
