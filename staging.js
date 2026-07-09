import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

// --- 1. SETUP ENVIRONMENT & STATE ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#f5f5f7');

const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
camera.position.set(0, 5, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

// Global State Arrays & Performance Memory Caches
const activeModels = [];
const modelCache = {}; // Prevents redundant network downloads and duplicate GPU allocations
let isEngineRunning = true;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// --- 2. CONTROLS INTERFACING (ORBIT & GIZMO) ---
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const transformControl = new TransformControls(camera, renderer.domElement);
transformControl.addEventListener('dragging-changed', (event) => {
    // Disable camera movement when moving or spinning models so viewports don't conflict
    orbitControls.enabled = !event.value;
});
scene.add(transformControl);

// Lighting & Environment Matrix
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
scene.add(dirLight);

const gridHelper = new THREE.GridHelper(20, 20, 0x888888, 0xcccccc);
scene.add(gridHelper);

const floorPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.MeshBasicMaterial({ visible: false })
);
floorPlane.rotation.x = -Math.PI / 2;
scene.add(floorPlane);

// Configure Draco Compression Decoder
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

// --- 3. CACHED ASSET SPAWNING ENGINE ---
function spawnModel(url) {
    // SCENARIO A: Instanced Cloning (Asset already loaded into browser memory)
    if (modelCache[url]) {
        console.log(`🚀 Cache Hit: Cloning instance from master memory profile for: ${url}`);
        const clonedModel = modelCache[url].clone();

        // Ensure standard transforms reset seamlessly
        clonedModel.position.set(0, 0, 0);
        clonedModel.rotation.set(0, 0, 0);
        clonedModel.scale.set(1, 1, 1);

        scene.add(clonedModel);
        activeModels.push(clonedModel);

        // Automatically isolate new instance onto target transform gizmo
        transformControl.attach(clonedModel);
        transformControl.setMode('translate');
        return;
    }

    // SCENARIO B: Network/Local File Initialization (First time rendering asset)
    console.log(`📦 Cache Miss: Initializing fresh data parse pipeline for: ${url}`);
    loader.load(url, (gltf) => {
        const masterModel = gltf.scene;

        masterModel.traverse((node) => {
            if (node.isMesh) {
                node.castShadow = true;
                node.receiveShadow = true;
                node.userData.isInteractable = true;
            }
        });

        // Store standard master model layout in cache reference dictionary
        modelCache[url] = masterModel;

        // Generate clean operational copy from master template
        const liveModel = masterModel.clone();
        liveModel.position.set(0, 0, 0);

        scene.add(liveModel);
        activeModels.push(liveModel);

        transformControl.attach(liveModel);
        transformControl.setMode('translate');
    }, undefined, (error) => console.error('Error parsing 3D file asset:', error));
}

// --- 4. SELECTION & DELETION LOGIC ---
function deleteSelectedObject() {
    const selectedObject = transformControl.object;
    if (!selectedObject) return;

    // Drop tracking parameters on target layout immediately
    transformControl.detach();
    scene.remove(selectedObject);

    // Deep clean instance structures from running rendering memory loops
    selectedObject.traverse((node) => {
        if (node.isMesh) {
            node.geometry.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach(mat => mat.dispose());
            } else {
                node.material.dispose();
            }
        }
    });

    const index = activeModels.indexOf(selectedObject);
    if (index > -1) activeModels.splice(index, 1);
}

// --- 5. INTERACTION EVENT LISTENERS ---
window.addEventListener('mousedown', (e) => {
    // Retain focus bounds if user clicks the operational gizmo itself
    if (transformControl.axis !== null) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(activeModels, true);

    if (intersects.length > 0) {
        // Isolate root asset grouping matrix below scene layout boundaries
        let root = intersects[0].object;
        while (root.parent && root.parent !== scene) {
            root = root.parent;
        }
        transformControl.attach(root);
    } else {
        // Detach gizmo if user clicks empty floor/background void spaces
        transformControl.detach();
    }
});

// Keyboard Mapping Handlers
window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;

    switch (e.key.toLowerCase()) {
        case 't': // Translate (Arrows Tool)
            transformControl.setMode('translate');
            break;
        case 'r': // Rotate (Rings Tool)
            transformControl.setMode('rotate');
            break;
        case 'delete':
        case 'backspace':
            e.preventDefault();
            deleteSelectedObject();
            break;
    }
});

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// --- 6. DYNAMIC FIREBASE STREAMING SIDEBAR ENGINE ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Initialize using your exact project configuration matrix
const firebaseConfig = {
    apiKey: "AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY",
    authDomain: "shot47-database.firebaseapp.com",
    projectId: "shot47-database",
    storageBucket: "shot47-database.firebasestorage.app",
    messagingSenderId: "77237094269",
    appId: "1:77237094269:web:a90a6c6239cb66e3102e14"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Local UI state management arrays
let liveAssetRegistry = {
    furniture: [],
    carpets: [],
    decor: []
};
let currentActiveCategory = 'furniture';

// Map your tabs to your actual matching Firestore collection endpoints
const collectionMap = {
    furniture: 'furniture_models',
    carpets: 'carpets_models',
    decor: 'decor_models'
};

// Open persistent database streams to all three asset categories
function initLiveCatalogSync() {
    console.log("📡 Attaching real-time streaming hooks to collections...");

    Object.keys(collectionMap).forEach((categoryKey) => {
        const firestoreCollection = collection(db, collectionMap[categoryKey]);

        // Establish an active listener stream
        onSnapshot(firestoreCollection, (snapshot) => {
            // Flush old collection entries before rewriting updated nodes
            liveAssetRegistry[categoryKey] = [];

            snapshot.forEach((doc) => {
                const data = doc.data();
                if (data.glb) { // Ensure a structural glb filename exists
                    liveAssetRegistry[categoryKey].push({
                        title: data.title || "Unnamed Object",
                        fileName: data.glb
                    });
                }
            });

            console.log(`✨ ${categoryKey} collection updated dynamically.`);
            
            // Re-render UI instantly if the user is currently viewing the updated tab
            if (categoryKey === currentActiveCategory) {
                renderCatalog(currentActiveCategory);
            }
        }, (error) => console.error(`Sync fault on ${categoryKey}:`, error));
    });
}

// Generate UI element grids matching selected data parameters
function renderCatalog(category) {
    const catalogContainer = document.getElementById('catalog-list');
    catalogContainer.innerHTML = ''; 

    const assets = liveAssetRegistry[category] || [];

    if (assets.length === 0) {
        catalogContainer.innerHTML = `<div class="empty-notice">Syncing collection matrix...</div>`;
        return;
    }

    assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'catalog-item state-loading';
        card.innerHTML = `<strong>${asset.title}</strong>`;
        catalogContainer.appendChild(card);

        // Resolve download paths directly from Firebase Storage bucket on demand
        const glbStorageRef = ref(storage, `models/glb/${asset.fileName}`);
        
        getDownloadURL(glbStorageRef)
            .then((secureUrl) => {
                card.classList.remove('state-loading');
                
                // Bind click event to trigger the main caching spawner engine
                card.addEventListener('click', () => {
                    spawnModel(secureUrl);
                });
            })
            .catch((err) => {
                console.error(`Storage asset mismatch on item [${asset.title}]:`, err);
                card.innerHTML = `<strong style="color:#ff3b30;">Error Loading</strong>`;
            });
    });
}

// Bind navigation filtering tabs to view modifications
document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        
        currentActiveCategory = e.target.getAttribute('data-category');
        renderCatalog(currentActiveCategory);
    });
});

// Fire connection engines at program execution setup runtime
initLiveCatalogSync();

// --- 7. ANIMATION EXECUTION & DEBUG MODULES ---
function animate() {
    if (!isEngineRunning) return;
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

// Emergency Debug Switch Hook
document.getElementById('freeze-btn').addEventListener('click', (e) => {
    isEngineRunning = !isEngineRunning;
    e.target.textContent = isEngineRunning ? "🛑 FREEZE ENGINE" : "▶️ RESUME ENGINE";
    e.target.style.backgroundColor = isEngineRunning ? "#ff3b30" : "#34c759";
    if (isEngineRunning) animate();
});

// Fire Pipeline Initialization
animate();
