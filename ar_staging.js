// ============================================================
// AR Retail Staging App
// ------------------------------------------------------------
// Single ES module bootstrapping the 8th Wall Open-Source XR session,
// initializing Firebase, pulling furniture items, and rendering
// GLB assets in AR.
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
// Helper: Request Permissions
// ------------------------------------------------------------
async function requestPermissions() {
    // 1. Request Camera Permission
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } }
            });
            // Stop temporary stream so 8th Wall / XR engine can capture the camera
            stream.getTracks().forEach(track => track.stop());
        } catch (err) {
            throw new Error('Camera permission was denied or camera is unavailable.');
        }
    }

    // 2. Request iOS Motion Sensor Permission
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
            const response = await DeviceOrientationEvent.requestPermission();
            if (response !== 'granted') {
                throw new Error('Motion sensor permission was denied.');
            }
        } catch (err) {
            throw new Error('Motion sensor permission error: ' + err.message);
        }
    }
}

// ------------------------------------------------------------
// Loader helpers
// ------------------------------------------------------------
function waitForXR8(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        if (window.XR8) {
            resolve(window.XR8);
            return;
        }

        const timer = setTimeout(() => {
            reject(new Error('Timed out waiting for 8th Wall XR engine to load from CDN.'));
        }, timeoutMs);

        const onXRLoaded = () => {
            clearTimeout(timer);
            resolve(window.XR8);
        };

        window.addEventListener('xrloaded', onXRLoaded, { once: true });

        const src = 'https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js';
        let script = document.querySelector(`script[src="${src}"]`);

        if (!script) {
            script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.setAttribute('data-preload-chunks', 'slam');
            script.onerror = () => {
                clearTimeout(timer);
                window.removeEventListener('xrloaded', onXRLoaded);
                reject(new Error('Failed to load 8th Wall script from CDN (Network/CORS error).'));
            };
            document.head.appendChild(script);
        } else {
            script.addEventListener('error', () => {
                clearTimeout(timer);
                window.removeEventListener('xrloaded', onXRLoaded);
                reject(new Error('Failed to load 8th Wall script from CDN (Network/CORS error).'));
            }, { once: true });
        }
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
        try {
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
        } catch (catErr) {
            console.warn(`Category ${category.label} could not be loaded:`, catErr);
        }
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

    previewGhost(state.selectedCatalogItem);
}

// ------------------------------------------------------------
// 8th Wall Open Source Engine bootstrap
// ------------------------------------------------------------
async function bootstrapEightWall() {
    const xr8 = await waitForXR8();

    if (xr8.loadChunk) {
        await xr8.loadChunk('slam');
    }

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
        // 1. Explicitly request permissions on user tap
        await requestPermissions();

        // 2. Hide permission overlay & show loader
        dom.permissionOverlay.style.display = 'none';
        setLoading(true);

        // 3. Initialize open-source 8th Wall XR engine
        await bootstrapEightWall();

        // 4. Fetch models from Firebase Storage
        try {
            await fetchCatalogue();
        } catch (catErr) {
            console.warn('Catalogue fetch failed:', catErr);
        }

        setLoading(false);
        setScanOverlay(true);
        state.initialized = true;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'AR initialization failed.';
        console.error('AR Startup Error:', message, error);
        setLoading(false);
        dom.permissionOverlay.style.display = 'flex';
        showToast(message);
    }
});

// ------------------------------------------------------------
// Kickoff
// ------------------------------------------------------------
(async function init() {
    setLoading(false);
    try {
        await initializeFirebase();
        console.info('Firebase initialized:', state.firebaseApp.name);
    } catch (error) {
        console.warn('Firebase config issue:', error);
    }
})();