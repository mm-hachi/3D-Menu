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

// --- 6. CATALOG DYNAMIC UI COUPLING ---
function setupCatalogItemItemListener(element) {
    element.addEventListener('click', () => spawnModel(element.getAttribute('data-url')));
}

document.querySelectorAll('.catalog-item').forEach(item => setupCatalogItemItemListener(item));

// Add Remote Web Asset Forms
document.getElementById('add-asset-btn').addEventListener('click', () => {
    const url = document.getElementById('asset-url-input').value.trim();
    const name = document.getElementById('asset-name-input').value.trim() || "Web Asset";
    if (!url) return alert("Please paste a valid URL.");

    createNewCatalogUIElement(name, url);
    spawnModel(url); // Auto-spawn remote links right on click

    document.getElementById('asset-url-input').value = '';
    document.getElementById('asset-name-input').value = '';
});

// Local File Tracker Interface via Blobs Array
document.getElementById('local-file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
        const blob = new Blob([event.target.result], { type: 'application/octet-stream' });
        const blobURL = URL.createObjectURL(blob);

        // Form clean UI card reference point before spawning
        const cleanName = file.name.replace('.glb', '');
        createNewCatalogUIElement(cleanName, blobURL);

        spawnModel(blobURL);
    }, false);
    reader.readAsArrayBuffer(file);
});

function createNewCatalogUIElement(name, targetUrl) {
    const newItem = document.createElement('div');
    newItem.className = 'catalog-item';
    newItem.setAttribute('data-url', targetUrl);
    newItem.innerHTML = `<strong>${name}</strong>`;
    document.getElementById('catalog-list').appendChild(newItem);
    setupCatalogItemItemListener(newItem);
}

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