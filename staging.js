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

// Renderer setup updated to preserve buffers for dynamic snapshots
const renderer = new THREE.WebGLRenderer({ 
    antialias: true, 
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true 
});
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

// Calibrated Lighting Matrix for Realtime Soft Shadows
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
dirLight.position.set(4, 12, 5);
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar(2048);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 25;
dirLight.shadow.camera.left = -6;
dirLight.shadow.camera.right = 6;
dirLight.shadow.camera.top = 6;
dirLight.shadow.camera.bottom = -6;
dirLight.shadow.bias = -0.0005; // Eradicates shadow acne/banding
scene.add(dirLight);

// Studio Grid Layout
scene.add(new THREE.GridHelper(30, 30, 0xaaaaaa, 0xdddddd));

// Low-overhead blend catcher for ground reflections/shadows
const shadowFloorGeo = new THREE.PlaneGeometry(50, 50);
const shadowFloorMat = new THREE.ShadowMaterial({ opacity: 0.25 });
const shadowFloor = new THREE.Mesh(shadowFloorGeo, shadowFloorMat);
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.position.y = 0.002; // Elevated imperceptibly above baseline lines
shadowFloor.receiveShadow = true;
shadowFloor.name = '__floor__';
scene.add(shadowFloor);

// Invisible target node dedicated to accurate physics raycasting tracking
const floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
);
floorMesh.rotation.x = -Math.PI / 2;
floorMesh.name = '__raycast_floor__';
scene.add(floorMesh);

// Bounding box wireframe helper tracking current active focus selections
const selectionBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x007aff);
selectionBoxHelper.visible = false;
scene.add(selectionBoxHelper);

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
orbitControls.maxPolarAngle = Math.PI / 2; 

const transformControls = new TransformControls(camera, renderer.domElement);
transformControls.setMode('translate');
scene.add(transformControls);

transformControls.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !e.value;
});

const boundaryBox = new THREE.Box3();

// Handle metrics updating and floor boundaries inside translation matrix loop
transformControls.addEventListener('change', () => {
    const attached = transformControls.object;
    if (attached) {
        selectionBoxHelper.setFromObject(attached);
        updateLiveDimensions(attached);
        
        if (transformControls.getMode() === 'translate') {
            boundaryBox.setFromObject(attached);
            if (boundaryBox.min.y < 0) {
                attached.position.y -= boundaryBox.min.y;
            }
        }
    }
});

transformControls.addEventListener('objectChange', () => {
    const attached = transformControls.object;
    if (attached) updateLiveDimensions(attached);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STATE
// ─────────────────────────────────────────────────────────────────────────────

const activeModels = [];
const modelCache = {};

let currentTool = 'translate';
let animating   = true;
let rafId       = null;

const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();

// Registry mapping out standard catalog finish modifications
const PRODUCT_VARIANTS = {
    fabrics: [
        { name: 'Charcoal', hex: '#2c3e50' },
        { name: 'Oatmeal',  hex: '#dfd5c6' },
        { name: 'Rust',     hex: '#b85a38' },
        { name: 'Emerald',  hex: '#0f5239' }
    ]
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. SPAWN / DELETE / SELECTION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function prepareMaster(root) {
    root.traverse((node) => {
        if (node.isMesh) {
            node.castShadow    = true;
            node.receiveShadow = true;
            if (node.material) node.material.envMapIntensity = 1.0;
        }
    });
}

function spawnFromCache(glbUrl, usdzUrl) {
    const mesh = modelCache[glbUrl].clone();
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);

    scene.add(mesh);
    activeModels.push({ mesh, glbUrl, usdzUrl: usdzUrl ?? null });

    if (currentTool !== 'delete') {
        transformControls.attach(mesh);
        handleSelectionFocus(mesh);
    }
}

function spawnModel(glbUrl, usdzUrl) {
    if (modelCache[glbUrl]) {
        spawnFromCache(glbUrl, usdzUrl);
        return;
    }

    gltfLoader.load(
        glbUrl,
        (gltf) => {
            prepareMaster(gltf.scene);
            modelCache[glbUrl] = gltf.scene;
            spawnFromCache(glbUrl, usdzUrl);
        },
        undefined,
        (err) => console.error('[spawnModel] Load error:', err)
    );
}

function deleteModel(entry) {
    if (!entry) return;

    if (transformControls.object === entry.mesh) {
        transformControls.detach();
        handleSelectionFocus(null);
    }

    scene.remove(entry.mesh);

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

/**
 * Triggers interactive canvas overlays, line limits, and variant selection drawers
 */
function handleSelectionFocus(targetMesh) {
    const badge = document.getElementById('dimension-badge');
    const variantDrawer = document.getElementById('variant-container');

    if (!targetMesh) {
        selectionBoxHelper.visible = false;
        badge.style.display = 'none';
        variantDrawer.style.display = 'none';
        return;
    }

    selectionBoxHelper.setFromObject(targetMesh);
    selectionBoxHelper.visible = true;

    updateLiveDimensions(targetMesh);
    renderVariantDrawer(targetMesh);
}

/**
 * Calculates absolute metrics based on geometry world-space scale properties
 */
function updateLiveDimensions(mesh) {
    const badge = document.getElementById('dimension-badge');
    const bbox = new THREE.Box3().setFromObject(mesh);
    
    const width  = (bbox.max.x - bbox.min.x).toFixed(2);
    const height = (bbox.max.y - bbox.min.y).toFixed(2);
    const depth  = (bbox.max.z - bbox.min.z).toFixed(2);

    badge.textContent = `SIZE: ${width}m (W) × ${height}m (H) × ${depth}m (D)`;
    badge.style.display = 'block';
}

/**
 * Renders interactive finish options inside the active workflow drawer
 */
function renderVariantDrawer(mesh) {
    const drawer = document.getElementById('variant-container');
    const group  = document.getElementById('swatch-group');
    group.innerHTML = ''; 

    const variants = PRODUCT_VARIANTS.fabrics;
    
    variants.forEach(variant => {
        const swatch = document.createElement('div');
        swatch.className = 'swatch';
        swatch.style.backgroundColor = variant.hex;
        swatch.setAttribute('title', variant.name);

        swatch.addEventListener('click', () => {
            mesh.traverse(child => {
                if (child.isMesh && child.material) {
                    // Unique local duplication checks to avoid global instance cross-contamination
                    if (!child.userData.isClonedMat) {
                        child.material = child.material.clone();
                        child.userData.isClonedMat = true;
                    }
                    child.material.color.set(variant.hex);
                }
            });
            
            document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active-swatch'));
            swatch.classList.add('active-swatch');
        });

        group.appendChild(swatch);
    });

    drawer.style.display = 'flex';
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
        handleSelectionFocus(entry.mesh);
    } else {
        transformControls.detach();
        handleSelectionFocus(null);
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
// 7. TOOLBAR / HOTKEYS
// ─────────────────────────────────────────────────────────────────────────────

function setActiveToolButton(targetButton) {
    document.getElementById('tool-translate').classList.remove('active-tool');
    document.getElementById('tool-rotate').classList.remove('active-tool');
    document.getElementById('tool-delete').classList.remove('active-tool');
    targetButton.classList.add('active-tool');
}

function setTool(tool) {
    currentTool = tool;

    if (tool === 'delete') {
        transformControls.detach();
        transformControls.visible = false;
        handleSelectionFocus(null);
        setActiveToolButton(document.getElementById('tool-delete'));
    } else {
        transformControls.visible = true;
        transformControls.setMode(tool);

        if (tool === 'rotate') {
            transformControls.showX = false;
            transformControls.showY = true;  
            transformControls.showZ = false;
        } else {
            transformControls.showX = true;
            transformControls.showY = true;
            transformControls.showZ = true;
        }

        setActiveToolButton(document.getElementById(
            tool === 'translate' ? 'tool-translate' : 'tool-rotate'
        ));
        
        if (transformControls.object) handleSelectionFocus(transformControls.object);
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
// 8. SNAPSHOT & NATIVE DEVICE SHARE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function captureAndShareScene() {
    const wasGizmoVisible = transformControls.visible;
    const wasBoxVisible   = selectionBoxHelper.visible;
    
    // Strips out tracking indicators before capturing memory frames
    transformControls.visible = false;
    selectionBoxHelper.visible = false;

    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    // Instantly restores operational helpers to runtime configurations
    transformControls.visible = wasGizmoVisible;
    selectionBoxHelper.visible = wasBoxVisible;
    renderer.render(scene, camera);

    if (navigator.share && navigator.canShare) {
        try {
            const blob = await (await fetch(dataUrl)).blob();
            const imageFile = new File([blob], `staging_layout_${Date.now()}.png`, { type: 'image/png' });

            if (navigator.canShare({ files: [imageFile] })) {
                await navigator.share({
                    files: [imageFile],
                    title: 'My Custom Room Staging Layout',
                    text: 'Take a look at this high-end room layout configuration I created!'
                });
            }
        } catch (error) {
            console.warn('[Share Engine] Operation bypassed or aborted.', error);
        }
    } else {
        // Desktop browser fallback configuration
        const downloadLink = Object.assign(document.createElement('a'), {
            href: dataUrl,
            download: `room_design_${Date.now()}.png`
        });
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
    }
}

document.getElementById('snapshot-btn').addEventListener('click', captureAndShareScene);

// ─────────────────────────────────────────────────────────────────────────────
// 9. AR EXPORT (Fixed to disable environmental scale/occlusion clipping shifts)
// ─────────────────────────────────────────────────────────────────────────────

async function buildMergedGLB() {
    scene.updateMatrixWorld(true);
    const exportGroup = new THREE.Group();

    activeModels.forEach(({ mesh }) => {
        const clone = mesh.clone(true);
        mesh.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
        exportGroup.add(clone);
    });

    const exporter = new GLTFExporter();
    return exporter.parseAsync(exportGroup, { binary: true, onlyVisible: true, animations: [] });
}

async function buildMergedUSDZ() {
    scene.updateMatrixWorld(true);
    const exportGroup = new THREE.Group();

    activeModels.forEach(({ mesh }) => {
        const clone = mesh.clone(true);
        mesh.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
        exportGroup.add(clone);
    });

    const exporter = new USDZExporter();
    return exporter.parse(exportGroup);
}

const isIOS     = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const isAndroid = /Android/i.test(navigator.userAgent);

async function uploadSceneFile(arrayBuffer, ext, onProgress) {
    const mimeType  = ext === 'usdz' ? 'model/vnd.usdz+zip' : 'application/octet-stream';
    const blob      = new Blob([arrayBuffer], { type: mimeType });
    const filename  = `ar_scene_${Date.now()}.${ext}`;
    const storageRef = ref(storage, `models/temp_stages/${filename}`);
    const uploadTask = uploadBytesResumable(storageRef, blob);

    if (onProgress) onProgress('⏳ Uploading…');

    await new Promise((resolve, reject) =>
        uploadTask.on('state_changed', null, reject, resolve)
    );

    return getDownloadURL(uploadTask.snapshot.ref);
}

function triggerQuickLook(httpsUrl) {
    const anchor = document.createElement('a');
    anchor.setAttribute('rel', 'ar');
    anchor.setAttribute('href', `${httpsUrl}#allowsScale=0`);
    anchor.style.cssText = 'display:none;position:fixed;';
    anchor.appendChild(document.createElement('img'));
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => document.body.removeChild(anchor), 500);
}

function openSceneViewer(glbUrl) {
    const encoded  = encodeURIComponent(glbUrl);
    const fallback = encodeURIComponent(window.location.href);

    // &disable_occlusion=true forces assets to override messy existing geometry
    window.location.href =
        `intent://arvr.google.com/scene-viewer/1.0` +
        `?file=${encoded}&mode=ar_preferred&resizable=false&disable_occlusion=true` +
        `#Intent;scheme=https;package=com.google.ar.core;` +
        `action=android.intent.action.VIEW;` +
        `S.browser_fallback_url=${fallback};end;`;
}

function downloadGLB(arrayBuffer) {
    const url = URL.createObjectURL(new Blob([arrayBuffer], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), {
        href: url,
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
            const onlyOne = activeModels.length === 1 && activeModels[0].usdzUrl;
            if (onlyOne) {
                setLabel('⚡ Opening…');
                triggerQuickLook(activeModels[0].usdzUrl);
            } else {
                setLabel('⚡ COMPILING…');
                const arrayBuffer = await buildMergedUSDZ();
                const usdzUrl     = await uploadSceneFile(arrayBuffer, 'usdz', setLabel);
                triggerQuickLook(usdzUrl);
            }
        } else if (isAndroid) {
            setLabel('⚡ COMPILING…');
            const arrayBuffer = await buildMergedGLB();
            const glbUrl      = await uploadSceneFile(arrayBuffer, 'glb', setLabel);
            openSceneViewer(glbUrl);
        } else {
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
// 10. FIREBASE CATALOG
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

        if (asset.imgName) {
            resolveUrl(asset.imgName, 'models/thumbnails')
                .then((url) => { img.src = url; })
                .catch(() => {});
        }

        const glbPromise  = resolveUrl(asset.glbName, 'models/glb');
        const usdzPromise = asset.usdzName ? resolveUrl(asset.usdzName, 'models/usdz') : Promise.resolve(null);

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

document.querySelectorAll('.tab-btn').forEach((tab) => {
    tab.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
        e.currentTarget.classList.add('active');
        activeCategory = e.currentTarget.dataset.category;
        renderCatalog(activeCategory);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. RENDER LOOP
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
// 12. WINDOW RESIZE HANDLER (Completed & Stabilized)
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
});

// Initialize Engine Processes
initCatalogSync();
startLoop();
