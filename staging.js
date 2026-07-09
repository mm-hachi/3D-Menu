import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage, ref, getDownloadURL, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// gltf-transform runtime for post-export optimization
import { WebIO } from 'https://esm.sh/@gltf-transform/core';
import { prune, dedup, weld, resample } from 'https://esm.sh/@gltf-transform/functions';

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
let isDeleteModeActive = false;

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

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const loader = new GLTFLoader();
loader.setDRACOLoader(dracoLoader);

// --- 3. CACHED ASSET SPAWNING ENGINE ---
function spawnModel(url) {
    if (modelCache[url]) {
        const clonedModel = modelCache[url].clone();
        clonedModel.position.set(0, 0, 0);
        clonedModel.rotation.set(0, 0, 0);
        clonedModel.scale.set(1, 1, 1);

        scene.add(clonedModel);
        activeModels.push(clonedModel);

        if (!isDeleteModeActive) {
            transformControl.attach(clonedModel);
        }
        return;
    }

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

        if (!isDeleteModeActive) {
            transformControl.attach(liveModel);
        }
    }, undefined, (error) => console.error('Error parsing production file asset:', error));
}

// --- 4. EXPLICIT DELETION ENGINE ---
function deleteTargetObject(targetObject) {
    if (!targetObject) return;

    if (transformControl.object === targetObject) {
        transformControl.detach();
    }

    scene.remove(targetObject);

    targetObject.traverse((node) => {
        if (node.isMesh) {
            node.geometry.dispose();
            if (Array.isArray(node.material)) {
                node.material.forEach(mat => mat.dispose());
            } else {
                node.material.dispose();
            }
        }
    });

    const index = activeModels.indexOf(targetObject);
    if (index > -1) activeModels.splice(index, 1);
}

// --- 5. INTERACTION EVENT LISTENERS & TOUCH OPTIMIZATION ---
function handleSceneInteraction(clientX, clientY) {
    if (transformControl.axis !== null && !isDeleteModeActive) return;

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

        if (isDeleteModeActive) {
            deleteTargetObject(root);
        } else {
            transformControl.attach(root);
        }
    } else {
        if (!isDeleteModeActive) {
            transformControl.detach();
        }
    }
}

window.addEventListener('mousedown', (e) => {
    if (e.target.closest('#canvas-container')) {
        handleSceneInteraction(e.clientX, e.clientY);
    }
});

window.addEventListener('touchstart', (e) => {
    if (e.target.closest('#canvas-container') && e.touches.length === 1) {
        handleSceneInteraction(e.touches[0].clientX, e.touches[0].clientY);
    }
}, { passive: true });

// --- TOOLBAR CONTROLS SYNC ENGINE ---
document.getElementById('tool-translate').addEventListener('click', (e) => {
    isDeleteModeActive = false;
    transformControl.visible = true;
    transformControl.setMode('translate');
    setActiveToolButton(e.target);
});

document.getElementById('tool-rotate').addEventListener('click', (e) => {
    isDeleteModeActive = false;
    transformControl.visible = true;
    transformControl.setMode('rotate');
    setActiveToolButton(e.target);
});

document.getElementById('tool-delete').addEventListener('click', (e) => {
    isDeleteModeActive = true;
    transformControl.detach();
    transformControl.visible = false;
    setActiveToolButton(e.target);
});

function setActiveToolButton(targetButton) {
    document.getElementById('tool-translate').classList.remove('active-tool');
    document.getElementById('tool-rotate').classList.remove('active-tool');
    document.getElementById('tool-delete').classList.remove('active-tool');
    targetButton.classList.add('active-tool');
}

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    switch (e.key.toLowerCase()) {
        case 't':
            isDeleteModeActive = false;
            transformControl.visible = true;
            transformControl.setMode('translate');
            setActiveToolButton(document.getElementById('tool-translate'));
            break;
        case 'r':
            isDeleteModeActive = false;
            transformControl.visible = true;
            transformControl.setMode('rotate');
            setActiveToolButton(document.getElementById('tool-rotate'));
            break;
        case 'delete':
        case 'backspace':
            e.preventDefault();
            deleteTargetObject(transformControl.object);
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

let liveAssetRegistry = { furniture: [], carpet: [], decor: [] };
let currentActiveCategory = 'furniture';

const collectionMap = {
    furniture: 'furniture_models',
    carpet: 'carpet_models',
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

// --- 7. GLTF-TRANSFORM EXPORT PIPELINE ---
function exportSceneToAR() {
    if (activeModels.length === 0) {
        return alert("Your staging floor is empty. Add models before viewing in AR.");
    }

    const arButton = document.getElementById('view-ar-btn');
    const originalText = arButton.textContent;
    arButton.textContent = "⚡ OPTIMIZING...";
    arButton.disabled = true;

    // Models sit directly under `scene` (not nested in another group), so their
    // local transforms already equal their world transforms. Cloning as-is is correct;
    // do NOT re-apply matrices here or you'll double-transform them.
    const exportScene = new THREE.Scene();

    activeModels.forEach((model) => {
        const modelClone = model.clone(true);

        modelClone.traverse((node) => {
            if (node.isMesh) {
                node.castShadow = false;
                node.receiveShadow = false;
                if (node.material) {
                    if (Array.isArray(node.material)) {
                        node.material.forEach(mat => { mat.userData = {}; });
                    } else {
                        node.material.userData = {};
                    }
                }
            }
        });
        exportScene.add(modelClone);
    });

    const exporter = new GLTFExporter();
    const exportOptions = { binary: true, animations: [], includeCustomExtensions: false, onlyVisible: true };

    exporter.parse(
        exportScene,
        async function (gltf) {
            try {
                arButton.textContent = "⚙️ RE-PACKING...";

                const io = new WebIO();
                const doc = await io.readBinary(new Uint8Array(gltf));

                await doc.transform(
                    dedup(),
                    prune(),
                    weld({ tolerance: 0.0001 }),
                    resample()
                );

                const optimizedGlbArray = await io.writeBinary(doc);

                const blob = new Blob([optimizedGlbArray], { type: 'model/gltf+binary' });

                const tempFilename = `scene_${Date.now()}.glb`;
                const storagePathRef = ref(storage, `models/temp_stages/${tempFilename}`);

                const metadata = {
                    contentType: 'model/gltf+binary',
                    cacheControl: 'public, max-age=31536000'
                };

                const uploadTask = uploadBytesResumable(storagePathRef, blob, metadata);

                uploadTask.on('state_changed',
                    null,
                    (error) => {
                        console.error("Upload error:", error);
                        arButton.textContent = originalText;
                        arButton.disabled = false;
                        alert("Cloud sync failure during compilation.");
                    },
                    async () => {
                        const secureCloudUrl = await getDownloadURL(uploadTask.snapshot.ref);

                        arButton.textContent = originalText;
                        arButton.disabled = false;

                        const isIOS = navigator.userAgent.match(/iPhone|iPad|iPod/i);
                        const isAndroid = navigator.userAgent.match(/Android/i);

                        if (isIOS) {
                            // IMPORTANT: Apple's AR Quick Look only accepts USDZ (or .reality)
                            // files — it will silently refuse a GLB. <model-viewer> does NOT
                            // auto-convert GLB -> USDZ; it needs a real `ios-src` pointing at
                            // an already-converted USDZ file. Until this pipeline produces one
                            // server-side (e.g. a Cloud Function running a USDZ converter),
                            // AR will not launch on iOS. Failing loudly here instead of
                            // silently, so it's obvious rather than looking like "nothing
                            // happened":
                            const mv = document.getElementById('hidden-ar-viewer');
                            if (mv && mv.iosSrc) {
                                mv.src = secureCloudUrl;
                                mv.addEventListener('load', () => {
                                    mv.activateAR();
                                }, { once: true });
                            } else {
                                alert(
                                    "AR Quick Look on iOS needs a USDZ file, not a GLB. " +
                                    "This scene was exported as GLB only — add a GLB→USDZ " +
                                    "conversion step and set the viewer's ios-src to the " +
                                    "converted file to enable iOS AR."
                                );
                            }

                        } else if (isAndroid) {
                            const safeUrl = encodeURIComponent(secureCloudUrl);
                            const fallbackUrl = encodeURIComponent(secureCloudUrl);

                            // Standard Scene Viewer intent format — file param is just the
                            // encoded URL, nothing appended to it.
                            const intentString =
                                `intent://arvr.google.com/scene-viewer/1.0?file=${safeUrl}&mode=ar_only` +
                                `#Intent;scheme=https;package=com.google.android.googlequicksearchbox;` +
                                `action=android.intent.action.VIEW;` +
                                `S.browser_fallback_url=${fallbackUrl};end;`;

                            const link = document.createElement('a');
                            link.href = intentString;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);

                        } else {
                            // Desktop fallback: download
                            const link = document.createElement('a');
                            link.href = secureCloudUrl;
                            link.download = tempFilename;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                        }
                    }
                );
            } catch (transformError) {
                console.error("gltf-transform execution runtime failure:", transformError);
                arButton.textContent = originalText;
                arButton.disabled = false;
                alert("Internal compiler error optimizing structural geometry elements.");
            }
        },
        exportOptions
    );
}

document.getElementById('view-ar-btn').addEventListener('click', exportSceneToAR);

// --- 8. ANIMATION LOOP ---
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

initLiveCatalogSync();
animate();
