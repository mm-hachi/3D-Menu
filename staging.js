import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Import Firebase Modular Framework tools + Upload Engines
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, getDownloadURL, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

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
    orbitControls.enabled = !event.value;
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
function handleSelection(clientX, clientY) {
    if (transformControl.axis !== null) return; 

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

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
}

window.addEventListener('mousedown', (e) => handleSelection(e.clientX, e.clientY));
window.addEventListener('touchstart', (e) => {
    if(e.touches.length === 1) handleSelection(e.touches[0].clientX, e.touches[0].clientY);
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
    carpets: 'carpet_models',
    decor: 'decor_models'
};

function initLiveCatalogSync() {
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

            if (categoryKey === currentActiveCategory) {
                renderCatalog(currentActiveCategory);
            }
        });
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
        
        card.innerHTML = `
            <div class="thumb-wrapper">
                <img class="catalog-thumb opacity-0" alt="${asset.title}" />
            </div>
            <div class="card-meta"><span>${asset.title}</span></div>
        `;
        catalogContainer.appendChild(card);

        const imgElement = card.querySelector('.catalog-thumb');

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
                    .catch(() => {
                        imgElement.src = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=150&q=80";
                        imgElement.classList.remove('opacity-0');
                    });
            }
        }

        const glbStorageRef = ref(storage, `models/glb/${asset.fileName}`);
        getDownloadURL(glbStorageRef)
            .then((secureUrl) => {
                card.classList.remove('state-loading');
                card.addEventListener('click', () => spawnModel(secureUrl));
            })
            .catch(() => {
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

// --- 7. CLOUD AR COMPILER EXPORT ENGINE (FIXED FOR MOBILE) ---
function exportSceneToAR() {
    if (activeModels.length === 0) {
        return alert("Your staging floor is empty. Add models before viewing in AR.");
    }

    const arButton = document.getElementById('view-ar-btn');
    arButton.textContent = "⚡ COMPILING SCENE...";
    arButton.disabled = true;

    const exporter = new GLTFExporter();
    const exportGroup = new THREE.Group();
    
    activeModels.forEach((model) => {
        exportGroup.add(model.clone());
    });

    exporter.parse(
        exportGroup,
        function (gltf) {
            const blob = new Blob([gltf], { type: 'application/octet-stream' });
            
            // Unique filename for this scene arrangement instance
            const tempFilename = `scene_${Date.now()}.glb`;
            const storagePathRef = ref(storage, `models/temp_stages/${tempFilename}`);

            console.log("☁️ Uploading custom playground configuration data matrix straight to cloud array...");
            const uploadTask = uploadBytesResumable(storagePathRef, blob);

            uploadTask.on('state_changed', 
                null, 
                (error) => {
                    console.error("Upload error:", error);
                    arButton.textContent = "📐 VIEW SCENE IN AR";
                    arButton.disabled = false;
                    alert("Cloud sync failure during compilation.");
                }, 
                async () => {
                    // Pull the fresh authenticated HTTPS download link back down
                    const secureCloudUrl = await getDownloadURL(uploadTask.snapshot.ref);
                    
                    arButton.textContent = "📐 VIEW SCENE IN AR";
                    arButton.disabled = false;

                    const isIOS = navigator.userAgent.match(/iPhone|iPad|iPod/i);
                    const link = document.createElement('a');
                    link.style.display = 'none';
                    document.body.appendChild(link);

                    if (isIOS) {
                        // iOS AR Quick Look directly mapping our valid hosted cloud token wrapper channel
                        link.href = `https://api.shot47-database.firebasestorage.app/v0/b/shot47-database.firebasestorage.app/o/${encodeURIComponent(`models/temp_stages/${tempFilename}`)}?alt=media`;
                        link.rel = "ar";
                        const img = document.createElement('img');
                        link.appendChild(img);
                    } else if (navigator.userAgent.match(/Android/i)) {
                        // Android Scene Viewer via clear absolute path routing protocol channel
                        link.href = `intent://arvr.google.com/scene-viewer/1.0?file=${secureCloudUrl}&mode=ar_only#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;end;`;
                    } else {
                        // Desktop Fallback Download configuration matrix
                        link.href = secureCloudUrl;
                        link.download = 'my-staged-scene.glb';
                    }

                    link.click();
                    document.body.removeChild(link);
                }
            );
        },
        (error) => {
            console.error(error);
            arButton.textContent = "📐 VIEW SCENE IN AR";
            arButton.disabled = false;
        },
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

// Fire connection engines at program execution setup runtime
initLiveCatalogSync();
animate();
