import * as THREE from 'three';
import { GLTFLoader }      from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls }   from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter }    from 'three/examples/jsm/exporters/GLTFExporter.js';
import { USDZExporter }    from 'three/examples/jsm/exporters/USDZExporter.js';

import { initializeApp }   from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL, uploadBytesResumable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. SCENE SETUP
// ─────────────────────────────────────────────────────────────────────────────

const container = document.getElementById('canvas-container');

const scene = new THREE.Scene();
scene.background = new THREE.Color('#f5f5f7');

const camera = new THREE.PerspectiveCamera(
    60,
    container.clientWidth / container.clientHeight,
    0.01,
    1000
);
camera.position.set(0, 4, 8);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.8));

const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(5, 10, 7);
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar(2048);
dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far  = 50;
scene.add(dirLight);

// Grid + invisible floor for raycasting
scene.add(new THREE.GridHelper(30, 30, 0xaaaaaa, 0xdddddd));

const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.name = '__floor__';
scene.add(floorMesh);

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOADERS
// ─────────────────────────────────────────────────────────────────────────────

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ─────────────────────────────────────────────────────────────────────────────
// 3. CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping  = true;
orbitControls.dampingFactor  = 0.08;
orbitControls.target.set(0, 0, 0);

// Lock stage rotation so the camera cannot orbit below the grid floor
orbitControls.maxPolarAngle = Math.PI / 2; 

// Optional: Prevent the user from looking completely straight down (birds-eye lock)
// orbitControls.minPolarAngle = 0.1; 

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
scene.add(transformControls);

// Pause orbit while the gizmo is being dragged
transformControls.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !e.value;
});

// Reusable Box3 to avoid garbage collection overhead during rapid drag events
const boundaryBox = new THREE.Box3();

// Enforce floor constraints during translation
transformControls.addEventListener('change', () => {
    const target = transformControls.object;
    
    // Only apply constraints when actively translating an object
    if (target && transformControls.getMode() === 'translate') {
        // Calculate the current world-space bounding box of the selected mesh
        boundaryBox.setFromObject(target);
        
        // Check if the absolute bottom point of the mesh dips below the grid floor (y = 0)
        if (boundaryBox.min.y < 0) {
            // Push the object back up by exactly how much it crossed the floor plane
            target.position.y -= boundaryBox.min.y;
        }
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STATE
// ─────────────────────────────────────────────────────────────────────────────

/** Each entry: { mesh: THREE.Object3D, glbUrl: string, usdzUrl: string|null } */
const activeModels = [];

/** Cache: glbUrl → THREE.Object3D (master, NEVER added to scene directly) */
const modelCache = {};

let currentTool = 'translate'; // 'translate' | 'rotate' | 'delete'
let animating   = true;
let rafId       = null;
let isDeleteModeActive = false;

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────────────
// 5. SPAWN / DELETE
// ─────────────────────────────────────────────────────────────────────────────

function prepareMaster(root) {
    root.traverse((node) => {
        if (node.isMesh) {
            node.castShadow    = true;
            node.receiveShadow = true;
        }
    });
}

/**
 * Clone the cached master and place it at the origin.
 * The clone shares geometry & material references — memory-efficient.
 */
function spawnFromCache(glbUrl, usdzUrl) {
    const mesh = modelCache[glbUrl].clone();
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);

    scene.add(mesh);
    activeModels.push({ mesh, glbUrl, usdzUrl: usdzUrl ?? null });

    if (currentTool !== 'delete') {
        transformControls.attach(mesh);
    }
}

/**
 * Load a GLB from URL, cache it (without adding to scene), then spawn.
 * usdzUrl is optional — stored so iOS can use it for single-model Quick Look.
 */
function spawnModel(glbUrl, usdzUrl) {
    if (modelCache[glbUrl]) {
        spawnFromCache(glbUrl, usdzUrl);
        return;
    }

    gltfLoader.load(
        glbUrl,
        (gltf) => {
            prepareMaster(gltf.scene);
            modelCache[glbUrl] = gltf.scene; // cache master — never add this to scene
            spawnFromCache(glbUrl, usdzUrl);
        },
        undefined,
        (err) => console.error('[spawnModel] Load error:', err)
    );
}

/**
 * Remove a model from the scene and dispose resources if no other
 * live instances share the same GLB.
 */
function deleteModel(entry) {
    if (!entry) return;

    if (transformControls.object === entry.mesh) {
        transformControls.detach();
    }

    scene.remove(entry.mesh);

    // Dispose only if this was the last live instance using this GLB
    const otherInstances = activeModels.filter(
        (e) => e !== entry && e.glbUrl === entry.glbUrl
    ).length;

    if (otherInstances === 0) {
        entry.mesh.traverse((node) => {
            if (!node.isMesh) return;
            node.geometry?.dispose();
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            mats.forEach((m) => m?.dispose());
        });
    }

    const idx = activeModels.indexOf(entry);
    if (idx !== -1) activeModels.splice(idx, 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RAYCASTING / INTERACTION
// ─────────────────────────────────────────────────────────────────────────────

function pickEntry(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x  =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    pointer.y  = -((clientY - rect.top)  / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const meshes = activeModels.map((e) => e.mesh);
    const hits   = raycaster.intersectObjects(meshes, true);
    if (hits.length === 0) return null;

    // Walk up from the hit node to its direct scene child
    let node = hits[0].object;
    while (node.parent && node.parent !== scene) node = node.parent;

    return activeModels.find((e) => e.mesh === node) ?? null;
}

function handlePointerDown(clientX, clientY) {
    if (transformControls.dragging) return;

    const entry = pickEntry(clientX, clientY);

    if (currentTool === 'delete') {
        if (entry) deleteModel(entry);
        return;
    }

    if (entry) {
        transformControls.attach(entry.mesh);
    } else {
        transformControls.detach();
    }
}

renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    handlePointerDown(e.clientX, e.clientY);
});

renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    handlePointerDown(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 7. TOOLBAR  (matches the IDs in the provided HTML)
// ─────────────────────────────────────────────────────────────────────────────

function setActiveToolButton(targetButton) {
    document.getElementById('tool-translate').classList.remove('active-tool');
    document.getElementById('tool-rotate').classList.remove('active-tool');
    document.getElementById('tool-delete').classList.remove('active-tool');
    targetButton.classList.add('active-tool');
}

function setTool(tool) {
    currentTool = tool;
    isDeleteModeActive = (tool === 'delete');

    if (tool === 'delete') {
        transformControls.detach();
        transformControls.visible = false;
        setActiveToolButton(document.getElementById('tool-delete'));
    } else {
        transformControls.visible = true;
        transformControls.setMode(tool);

        // Axis-locking pipeline for floor staging constraints
        if (tool === 'rotate') {
            // Lock out pitch and roll; expose only the green horizontal yaw ring
            transformControls.showX = false;
            transformControls.showY = true;  // Green axis ring
            transformControls.showZ = false;
        } else {
            // Re-expose all three movement vectors when switching back to translation
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
        }

        setActiveToolButton(document.getElementById(
            tool === 'translate' ? 'tool-translate' : 'tool-rotate'
        ));
    }
}

document.getElementById('tool-translate').addEventListener('click', () => setTool('translate'));
document.getElementById('tool-rotate').addEventListener('click',    () => setTool('rotate'));
document.getElementById('tool-delete').addEventListener('click',    () => setTool('delete'));

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;

    switch (e.key.toLowerCase()) {
        case 't':
            setTool('translate');
            break;
        case 'r':
            setTool('rotate');
            break;
        case 'delete':
        case 'backspace': {
            e.preventDefault();
            const attached = transformControls.object;
            if (!attached) return;
            const entry = activeModels.find((en) => en.mesh === attached);
            if (entry) deleteModel(entry);
            break;
        }
    }
});

document.getElementById('freeze-btn').addEventListener('click', (e) => {
    animating = !animating;
    e.currentTarget.textContent = animating ? '🛑 FREEZE ENGINE' : '▶️ RESUME ENGINE';
    e.currentTarget.style.backgroundColor = animating ? '#ff3b30' : '#34c759';
    if (animating) startLoop();
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. AR EXPORT  —  multi-model, works on iOS (Quick Look) & Android (Scene Viewer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge all active models into a single GLB ArrayBuffer with world transforms
 * baked in so the AR viewer sees the correct arrangement.
 */
async function buildMergedGLB() {
    scene.updateMatrixWorld(true);

    const exportGroup = new THREE.Group();

    activeModels.forEach(({ mesh }) => {
        const clone = mesh.clone(true);
        // Decompose world matrix → local transform of the clone so positions
        // are preserved when the clone is placed in the flat exportGroup.
        mesh.matrixWorld.decompose(
            clone.position,
            clone.quaternion,
            clone.scale
        );
        exportGroup.add(clone);
    });

    const exporter = new GLTFExporter();
    return exporter.parseAsync(exportGroup, {
        binary:      true,
        onlyVisible: true,
        animations:  [],
    }); // → ArrayBuffer
}

/**
 * Merge all active models into a single USDZ Uint8Array with world transforms
 * baked in so the iOS AR viewer sees the correct arrangement.
 */
async function buildMergedUSDZ() {
    scene.updateMatrixWorld(true);

    const exportGroup = new THREE.Group();

    activeModels.forEach(({ mesh }) => {
        const clone = mesh.clone(true);
        mesh.matrixWorld.decompose(
            clone.position,
            clone.quaternion,
            clone.scale
        );
        exportGroup.add(clone);
    });

    const exporter = new USDZExporter();
    return exporter.parse(exportGroup); // → Uint8Array
}

const isIOS     = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);

/**
 * Upload an ArrayBuffer to Firebase Storage under models/temp_stages/.
 * Returns the public HTTPS download URL.
 */
async function uploadSceneFile(arrayBuffer, ext, onProgress) {
    const mimeType  = ext === 'usdz' ? 'model/vnd.usdz+zip' : 'application/octet-stream';
    const blob      = new Blob([arrayBuffer], { type: mimeType });
    const filename  = `ar_scene_${Date.now()}.${ext}`;
    const storageRef = ref(storage, `models/temp_stages/${filename}`);
    const uploadTask = uploadBytesResumable(storageRef, blob);

    console.log(`[AR] Uploading ${(blob.size / 1024 / 1024).toFixed(2)} MB …`);
    if (onProgress) onProgress('⏳ Uploading…');

    await new Promise((resolve, reject) =>
        uploadTask.on('state_changed', null, reject, resolve)
    );

    return getDownloadURL(uploadTask.snapshot.ref);
}

/**
 * iOS Quick Look — trigger AR via a <a rel="ar"> anchor.
 *
 * IMPORTANT: blob: URLs do NOT work here. Quick Look runs as a separate
 * OS-level process (outside the browser sandbox) and cannot access blob URLs —
 * which is why the prompt appeared but nothing loaded previously.
 *
 * The anchor must use a real public HTTPS URL. We obtain that by uploading
 * the merged GLB to Firebase Storage first.
 *
 * For single-model scenes where a USDZ is already available in Firebase,
 * we use that directly (faster, better quality, no upload needed).
 */
function triggerQuickLook(httpsUrl) {
    const anchor = document.createElement('a');
    anchor.setAttribute('rel', 'ar');
    anchor.setAttribute('href', httpsUrl);
    anchor.style.cssText = 'display:none;position:fixed;';

    // Safari requires a child <img> element on the anchor or Quick Look won't open.
    anchor.appendChild(document.createElement('img'));

    document.body.appendChild(anchor);
    anchor.click();

    setTimeout(() => document.body.removeChild(anchor), 500);
}

/**
 * Android Scene Viewer via intent URL.
 * Scene Viewer also requires a public HTTPS URL — blob: URLs are not supported.
 */
function openSceneViewer(glbUrl) {
    const encoded  = encodeURIComponent(glbUrl);
    const fallback = encodeURIComponent(window.location.href);

    // ar_preferred degrades gracefully if ARCore isn't installed.
    window.location.href =
        `intent://arvr.google.com/scene-viewer/1.0` +
        `?file=${encoded}&mode=ar_preferred` +
        `#Intent;scheme=https;package=com.google.ar.core;` +
        `action=android.intent.action.VIEW;` +
        `S.browser_fallback_url=${fallback};end;`;
}

/**
 * Desktop fallback — download the merged GLB.
 */
function downloadGLB(arrayBuffer) {
    const url = URL.createObjectURL(
        new Blob([arrayBuffer], { type: 'application/octet-stream' })
    );
    const a       = Object.assign(document.createElement('a'), {
        href:     url,
        download: `staged_scene_${Date.now()}.glb`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleARButton() {
    if (activeModels.length === 0) {
        alert('Your staging floor is empty. Add at least one model before viewing in AR.');
        return;
    }

    const arBtn        = document.getElementById('view-ar-btn');
    const originalLabel = arBtn.textContent;
    arBtn.disabled     = true;

    const setLabel = (text) => { arBtn.textContent = text; };

    try {
        if (isIOS) {
            // ── iOS path ─────────────────────────────────────────────────────
            // Single model with a pre-existing USDZ → open it directly.
            // This is the fastest path and gives the best visual quality.
            const onlyOne = activeModels.length === 1 && activeModels[0].usdzUrl;

            if (onlyOne) {
                setLabel('⚡ Opening…');
                triggerQuickLook(activeModels[0].usdzUrl);
            } else {
                // Multiple models (or no USDZ) → export merged USDZ and upload.
                // Quick Look cannot read blob: URLs from an async context reliably, 
                // so we use a real HTTPS URL.
                setLabel('⚡ COMPILING…');
                const arrayBuffer = await buildMergedUSDZ();
                const usdzUrl     = await uploadSceneFile(arrayBuffer, 'usdz', setLabel);
                triggerQuickLook(usdzUrl);
            }

        } else if (isAndroid) {
            // ── Android path ─────────────────────────────────────────────────
            setLabel('⚡ COMPILING…');
            const arrayBuffer = await buildMergedGLB();
            const glbUrl      = await uploadSceneFile(arrayBuffer, 'glb', setLabel);
            openSceneViewer(glbUrl);

        } else {
            // ── Desktop fallback ─────────────────────────────────────────────
            setLabel('⚡ COMPILING…');
            const arrayBuffer = await buildMergedGLB();
            downloadGLB(arrayBuffer);
        }

    } catch (err) {
        console.error('[AR Export] Error:', err);
        alert('AR export failed. See the browser console for details.');
    } finally {
        setLabel(originalLabel);
        arBtn.disabled = false;
    }
}

document.getElementById('view-ar-btn').addEventListener('click', handleARButton);

// ─────────────────────────────────────────────────────────────────────────────
// 9. FIREBASE CATALOG
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

// Note: these collection names match your original staging.js exactly
const collectionMap = {
    furniture: 'furniture_models',
    carpets:   'carpet_models',
    decor:     'decor_models',
};

async function resolveUrl(pathOrUrl, folder) {
    if (!pathOrUrl) throw new Error('No path provided');
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    return getDownloadURL(ref(storage, `${folder}/${pathOrUrl}`));
}

function renderCatalog(category) {
    const list   = document.getElementById('catalog-list');
    list.innerHTML = '';

    const assets = registry[category] ?? [];

    if (assets.length === 0) {
        list.innerHTML = '<div class="empty-notice">Updating digital catalog…</div>';
        return;
    }

    assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'catalog-item visual-card state-loading';
        card.innerHTML = `
            <div class="thumb-wrapper">
                <img class="catalog-thumb" alt="${asset.title}" />
            </div>
            <div class="card-meta"><span>${asset.title}</span></div>
        `;
        list.appendChild(card);

        const img = card.querySelector('.catalog-thumb');

        // Thumbnail
        if (asset.imgName) {
            resolveUrl(asset.imgName, 'models/thumbnails')
                .then((url) => { img.src = url; })
                .catch(() => { /* leave blank */ });
        }

        // Resolve GLB + optional USDZ, then enable card click
        const glbPromise  = resolveUrl(asset.glbName, 'models/glb');
        const usdzPromise = asset.usdzName
            ? resolveUrl(asset.usdzName, 'models/usdz')
            : Promise.resolve(null);

        Promise.all([glbPromise, usdzPromise])
            .then(([glbUrl, usdzUrl]) => {
                card.classList.remove('state-loading');
                card.addEventListener('click', () => spawnModel(glbUrl, usdzUrl));
            })
            .catch(() => {
                card.classList.remove('state-loading');
                card.classList.add('error-state');
                card.title = 'Asset unavailable';
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
                    title:    d.title   ?? 'Unnamed',
                    glbName:  d.glb,
                    usdzName: d.usdz    ?? null,
                    imgName:  d.img     ?? null,
                });
            });
            if (category === activeCategory) renderCatalog(activeCategory);
        });
    });
}

// Category tab switching — matches .tab-btn[data-category] in HTML
document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
        e.currentTarget.classList.add('active');
        activeCategory = e.currentTarget.dataset.category;
        renderCatalog(activeCategory);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. RENDER LOOP
// ─────────────────────────────────────────────────────────────────────────────

function startLoop() {
    if (rafId !== null) return;
    (function loop() {
        if (!animating) { rafId = null; return; }
        rafId = requestAnimationFrame(loop);
        orbitControls.update();
        renderer.render(scene, camera);
    })();
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. RESIZE
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

initCatalogSync();
setTool('translate');
startLoop();
