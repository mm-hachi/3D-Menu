import * as THREE from 'three';
import { GLTFLoader }      from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }     from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls }   from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFExporter }    from 'three/examples/jsm/exporters/GLTFExporter.js';
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
// Grid
scene.add(new THREE.GridHelper(30, 30, 0xaaaaaa, 0xdddddd));
// Invisible floor for raycasting (place models on it)
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
const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
scene.add(transformControls);
// Pause orbit while the gizmo is being dragged
transformControls.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !e.value;
});
// ─────────────────────────────────────────────────────────────────────────────
// 4. STATE
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Each entry: { mesh: THREE.Object3D, glbUrl: string, usdzUrl: string|null }
 */
const activeModels = [];
/**
 * Cache: glbUrl → THREE.Object3D (master copy, NEVER added to scene)
 */
const modelCache = {};
let currentTool = 'translate'; // 'translate' | 'rotate' | 'delete'
let animating   = true;
let rafId       = null;
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
 * Clones share geometry/material references — efficient for multiple instances.
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
            modelCache[glbUrl] = gltf.scene; // cache master — never scene.add this
            spawnFromCache(glbUrl, usdzUrl);
        },
        undefined,
        (err) => console.error('[spawnModel] Load error:', err)
    );
}
/**
 * Remove an entry from the scene and dispose resources if no other
 * live instances share the same geometry/material.
 */
function deleteModel(entry) {
    if (!entry) return;
    if (transformControls.object === entry.mesh) {
        transformControls.detach();
    }
    scene.remove(entry.mesh);
    // Only dispose if this was the last live instance of this model
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
/**
 * Returns the activeModels entry hit by a ray from (clientX, clientY),
 * or null if nothing was hit.
 */
function pickEntry(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x  =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    pointer.y  = -((clientY - rect.top)  / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = activeModels.map((e) => e.mesh);
    const hits   = raycaster.intersectObjects(meshes, true);
    if (hits.length === 0) return null;
    // Walk up from the hit node to the direct scene child
    let node = hits[0].object;
    while (node.parent && node.parent !== scene) node = node.parent;
    return activeModels.find((e) => e.mesh === node) ?? null;
}
function handlePointerDown(clientX, clientY) {
    // Don't interfere with an active gizmo drag
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
// Use the canvas element so touch events don't bubble through the sidebar
renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // left-click / tap only
    handlePointerDown(e.clientX, e.clientY);
});
renderer.domElement.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    handlePointerDown(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
// ─────────────────────────────────────────────────────────────────────────────
// 7. TOOLBAR  (matches existing HTML IDs)
// ─────────────────────────────────────────────────────────────────────────────
const btnTranslate = document.getElementById('tool-translate');
const btnRotate    = document.getElementById('tool-rotate');
const btnDelete    = document.getElementById('tool-delete');
const btnFreeze    = document.getElementById('freeze-btn');
const btnAR        = document.getElementById('view-ar-btn');
function setTool(tool) {
    currentTool = tool;
    // Reset all tool buttons
    [btnTranslate, btnRotate, btnDelete].forEach((btn) => {
        btn.classList.remove('active-tool');
    });
    if (tool === 'translate') {
        btnTranslate.classList.add('active-tool');
        transformControls.visible = true;
        transformControls.setMode('translate');
    } else if (tool === 'rotate') {
        btnRotate.classList.add('active-tool');
        transformControls.visible = true;
        transformControls.setMode('rotate');
    } else if (tool === 'delete') {
        btnDelete.classList.add('active-tool');
        transformControls.detach();
        transformControls.visible = false;
    }
}
btnTranslate.addEventListener('click', () => setTool('translate'));
btnRotate.addEventListener('click',    () => setTool('rotate'));
btnDelete.addEventListener('click',    () => setTool('delete'));
// Freeze / Resume
btnFreeze.addEventListener('click', () => {
    animating = !animating;
    btnFreeze.textContent = animating ? '🛑 FREEZE ENGINE' : '▶️ RESUME ENGINE';
    btnFreeze.style.backgroundColor = animating ? '' : '#34c759';
    if (animating) startLoop();
});
// Keyboard shortcuts
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
// ─────────────────────────────────────────────────────────────────────────────
// 8. AR  —  uses the <model-viewer> already in the HTML
// ─────────────────────────────────────────────────────────────────────────────
const arViewer = document.getElementById('hidden-ar-viewer');
const isIOS    = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);
/**
 * iOS: set the model-viewer src/ios-src and call activateAR().
 * model-viewer handles the rel="ar" anchor internally — this works
 * inside a user-gesture (button click).
 */
function openARiOS(glbUrl, usdzUrl) {
    if (!usdzUrl) {
        alert('No USDZ file is available for this model.');
        return;
    }
    arViewer.src    = glbUrl;
    arViewer.iosSrc = usdzUrl;
    // activateAR() must be called synchronously within the click handler
    // model-viewer will trigger Quick Look automatically
    arViewer.activateAR();
}
/**
 * Android: export the full arranged scene as a single GLB,
 * upload to Firebase, then open via Scene Viewer intent URL.
 */
async function exportAndOpenAndroid() {
    const originalLabel = btnAR.textContent;
    btnAR.textContent = '⏳ Exporting…';
    btnAR.disabled = true;
    try {
        // Build an export group with world-space transforms baked in
        const exportGroup = new THREE.Group();
        activeModels.forEach(({ mesh }) => {
            mesh.updateWorldMatrix(true, true);
            const clone = mesh.clone(true);
            // Decompose world matrix into the clone's local transform
            mesh.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
            exportGroup.add(clone);
        });
        const exporter = new GLTFExporter();
        const arrayBuffer = await exporter.parseAsync(exportGroup, {
            binary:       true,
            onlyVisible:  true,
            animations:   [],
        });
        const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
        console.log(`[AR] GLB size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
        const filename   = `ar_scene_${Date.now()}.glb`;
        const storageRef = ref(storage, `models/temp_stages/${filename}`);
        const task       = uploadBytesResumable(storageRef, blob);
        await new Promise((resolve, reject) => task.on('state_changed', null, reject, resolve));
        const glbUrl  = await getDownloadURL(task.snapshot.ref);
        const encoded = encodeURIComponent(glbUrl);
        const fallback = encodeURIComponent(window.location.href);
        // Scene Viewer intent — requires browser_fallback_url for devices without ARCore
        window.location.href =
            `intent://arvr.google.com/scene-viewer/1.0` +
            `?file=${encoded}&mode=ar_only` +
            `#Intent;scheme=https;package=com.google.ar.core;` +
            `action=android.intent.action.VIEW;` +
            `S.browser_fallback_url=${fallback};end;`;
    } catch (err) {
        console.error('[AR] Export error:', err);
        alert('AR export failed. See console for details.');
    } finally {
        btnAR.textContent = originalLabel;
        btnAR.disabled = false;
    }
}
btnAR.addEventListener('click', () => {
    if (activeModels.length === 0) {
        alert('Add at least one model to the scene first.');
        return;
    }
    if (isIOS) {
        // Quick Look: use the most recently placed model's USDZ.
        // (iOS Quick Look cannot composite multiple USDZ files in-browser.)
        const last = activeModels[activeModels.length - 1];
        openARiOS(last.glbUrl, last.usdzUrl);
    } else {
        // Android + Desktop: export scene GLB and launch Scene Viewer / download
        exportAndOpenAndroid();
    }
});
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
const registry = { furniture: [], carpet: [], decor: [] };
let activeCategory = 'furniture';
const collectionMap = {
    furniture: 'furniture_models',
    carpet:    'carpet_models',
    decor:     'decor_models',
};
/**
 * Resolve a Storage filename or a full https:// URL to a signed download URL.
 */
async function resolveUrl(pathOrUrl, folder) {
    if (!pathOrUrl) throw new Error('No path provided');
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    return getDownloadURL(ref(storage, `${folder}/${pathOrUrl}`));
}
/**
 * Render the catalog grid using the existing CSS classes from staging.css.
 */
function renderCatalog(category) {
    const list   = document.getElementById('catalog-list');
    list.innerHTML = '';
    const assets = registry[category] ?? [];
    if (assets.length === 0) {
        list.innerHTML = '<div class="empty-notice">Loading catalog…</div>';
        return;
    }
    assets.forEach((asset) => {
        // Matches the existing .catalog-item.visual-card structure in staging.css
        const card = document.createElement('div');
        card.className = 'catalog-item visual-card state-loading';
        card.innerHTML = `
            <div class="thumb-wrapper">
                <img class="catalog-thumb" alt="${asset.title}" />
            </div>
            <div class="card-meta">
                <span>${asset.title}</span>
            </div>
        `;
        list.appendChild(card);
        const img = card.querySelector('.catalog-thumb');
        // ── Thumbnail ──────────────────────────────────────────
        if (asset.imgName) {
            resolveUrl(asset.imgName, 'models/thumbnails')
                .then((url) => { img.src = url; })
                .catch(() => { /* leave blank — no broken-image icon */ });
        }
        // ── GLB + USDZ URLs ────────────────────────────────────
        const glbPromise  = resolveUrl(asset.glbName,  'models/glb');
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
                if (!d.glb) return; // skip docs without a GLB
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
// Category tab switching — matches existing .tab-btn[data-category] HTML
document.querySelectorAll('.tab-btn[data-category]').forEach((tab) => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn[data-category]').forEach((t) =>
            t.classList.remove('active')
        );
        e.currentTarget.classList.add('active');
        activeCategory = e.currentTarget.dataset.category;
        renderCatalog(activeCategory);
    });
});
// ─────────────────────────────────────────────────────────────────────────────
// 10. RENDER LOOP
// ─────────────────────────────────────────────────────────────────────────────
function startLoop() {
    if (rafId !== null) return; // guard — only one loop ever runs
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
