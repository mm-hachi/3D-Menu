import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Import Firebase Modular Framework tools
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

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

const activeModels = [];
const modelCache = {}; 
let isEngineRunning = true;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// --- 2. CONTROLS INTERFACING (ORBIT & GIZMO) ---
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;

const transformControl = new TransformControls(camera, renderer.domElement);
transformControl.addEventListener('dragging-changed', (event) => {
    orbitControls.enabled = !event.value; // Prevent view collision while transforming assets
});
scene.add(transformControl);

// Lighting Matrix
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
    if (modelCache[url]) {
        console.log(`🚀 Cache Hit: Re-instancing geometry profile: ${url}`);
        const clonedModel = modelCache[url].clone();
        
        clonedModel.position.set(0, 0, 0);
        clonedModel.rotation.set(0, 0, 0);
        clonedModel.scale.set(1, 1, 1);

        scene.add(clonedModel);
        activeModels.push(clonedModel);
        
        transformControl.attach(clonedModel);
        return;
    }

    console.log(`📦 Cache Miss: Initializing data stream parsing pipeline: ${url}`);
    loader.load(url, (gltf) => {
        const masterModel = gltf.scene;

        masterModel.traverse((node) => {
            if (node.isMesh) {
                node.castShadow = true;
                node.receiveShadow = true;
                node.userData.isInteractable = true; 
            }
        });

        modelCache[url] = masterModel;

        const liveModel = masterModel.clone();
        liveModel.position.set(0, 0, 0);

        scene.add(liveModel);
        activeModels.push(liveModel);

        transformControl.attach(liveModel);
    }, undefined, (error) => console.error('Error parsing production file asset:', error));
}

// --- 4. SELECTION & DELETION LOGIC ---
function deleteSelectedObject() {
    const selectedObject = transformControl.object;
    if (!selectedObject) return;

    transformControl.detach();
    scene.remove(selectedObject);

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
    if (transformControl.axis !== null) return; 

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(activeModels, true);

    if (intersects.length > 0) {
        let root = intersects[0].object;
        while (root.parent && root.parent !== scene) {
            root = root.parent;
        }
        transformControl.attach(root);
    } else {
        transformControl.detach();
    }
});

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;

    switch (e.key.toLowerCase()) {
        case 't':
            transformControl.setMode('translate');
            break;
        case 'r':
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

// --- 6. DYNAMIC FIREBASE STREAMING SIDEBAR GALLERY ---
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

let liveAssetRegistry = { furniture: [], carpets: [], decor: [] };
let currentActiveCategory = 'furniture';

const collectionMap = {
    furniture: 'furniture_models',
    carpets: 'carpets_models',
    decor: 'decor_models'
};

function initLiveCatalogSync() {
    console.log("📡 Attaching real-time streaming hooks to all portfolio collections...");

    Object.keys(collectionMap).forEach((categoryKey) => {
        const firestoreCollection = collection(db, collectionMap[categoryKey]);

        onSnapshot(firestoreCollection, (snapshot) => {
            liveAssetRegistry[categoryKey] = [];

            snapshot.forEach((doc) => {
                const data = doc.data();
                if (data.glb) { 
                    liveAssetRegistry[categoryKey].push({
                        title: data.title || "Unnamed Object",
                        fileName: data.glb,
                        imgName: data.img || ""
                    });
                }
            });

            console.log(`✨ Sync complete for collection profile: ${categoryKey}`);
            if (categoryKey === currentActiveCategory) {
                renderCatalog(currentActiveCategory);
            }
        }, (error) => console.error(`Sync error on portfolio group [${categoryKey}]:`, error));
    });
}

function renderCatalog(category) {
    const catalogContainer = document.getElementById('catalog-list');
    catalogContainer.innerHTML = ''; 

    const assets = liveAssetRegistry[category] || [];

    if (assets.length === 0) {
        catalogContainer.innerHTML = `<div class="empty-notice">Updating digital catalog...</div>`;
        return;
    }

    assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'catalog-item visual-card state-loading';
        card.title = asset.title;
        
        card.innerHTML = `
            <div class="thumb-wrapper">
                <img class="catalog-thumb opacity-0" alt="${asset.title}" />
            </div>
            <div class="card-meta"><span>${asset.title}</span></div>
        `;
        catalogContainer.appendChild(card);

        const imgElement = card.querySelector('.catalog-thumb');

        // Resolve Image Thumbnail File Reference Profile
        if (asset.imgName) {
            if (asset.imgName.startsWith('http')) {
                imgElement.src = asset.imgName;
                imgElement.classList.remove('opacity-0');
            } else {
                const thumbStorageRef = ref(storage, `models/thumbnails/${asset.imgName}`);
                getDownloadURL(thumbStorageRef)
                    .then((url) => {
                        imgElement.src = url;
                        imgElement.classList.remove('opacity-0');
                    })
                    .catch((err) => {
                        console.error(`Thumbnail path missing reference: ${asset.imgName}`, err);
                        imgElement.src = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=150&q=80";
                        imgElement.classList.remove('opacity-0');
                    });
            }
        }

        // Resolve GLB Run-time Geometry Data Reference
        const glbStorageRef = ref(storage, `models/glb/${asset.fileName}`);
        getDownloadURL(glbStorageRef)
            .then((secureUrl) => {
                card.classList.remove('state-loading');
                card.addEventListener('click', () => spawnModel(secureUrl));
            })
            .catch((err) => {
                console.error(`Missing runtime asset reference deployment [${asset.title}]:`, err);
                card.classList.add('error-state');
            });
    });
}

document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        
        currentActiveCategory = e.target.getAttribute('data-category');
        renderCatalog(currentActiveCategory);
    });
});

// --- 7. AR EXPORT COMPILATION ENGINE ---
function exportSceneToAR() {
    if (activeModels.length === 0) {
        return alert("Your staging floor is empty. Add models before viewing in AR.");
    }

    const exporter = new GLTFExporter();
    const exportGroup = new THREE.Group();
    
    activeModels.forEach((model) => {
        exportGroup.add(model.clone());
    });

    console.log("🛠️ Compiling spatial scene layout for AR execution channels...");

    exporter.parse(
        exportGroup,
        function (gltf) {
            const blob = new Blob([gltf], { type: 'application/octet-stream' });
            const blobURL = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.style.display = 'none';
            document.body.appendChild(link);

            // Direct intent call link targeting Android native Scene Viewer pipelines
            link.href = `intent://arvr.google.com/scene-viewer/1.0?file=${window.location.origin}/${blobURL}&mode=ar_only#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;end;`;
            
            // Fallback for desktop configurations
            if (!navigator.userAgent.match(/Android|iPhone|iPad/i)) {
                link.href = blobURL;
                link.download = 'my-staged-scene.glb';
                console.log("💾 Desktop detected: Downloading compiled room asset schema configuration.");
            }

            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(blobURL);
        },
        (error) => console.error('An error occurred during scene composition compilation:', error),
        { binary: true }
    );
}

document.getElementById('view-ar-btn').addEventListener('click', exportSceneToAR);

// --- 8. ANIMATION ENGINE RUNTIME TRACKING ---
function animate() {
    if (!isEngineRunning) return;
    requestAnimationFrame(animate);
    orbitControls.update();
    renderer.render(scene, camera);
}

document.getElementById('freeze-btn').addEventListener('click', (e) => {
    isEngineRunning = !isEngineRunning;
    e.target.textContent = isEngineRunning ? "🛑 FREEZE ENGINE" : "▶️ RESUME ENGINE";
    e.target.style.backgroundColor = isEngineRunning ? "#ff3b30" : "#34c759";
    if (isEngineRunning) animate();
});

// Kickstart Background Event Loops
initLiveCatalogSync();
animate();
