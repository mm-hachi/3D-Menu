import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// 8th Wall's XR8.Threejs.pipelineModule() looks for window.THREE.
// ES module imports are scoped and don't auto-expose globals, so we
// must attach it manually before the XR8 pipeline is initialized.
window.THREE = THREE;

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. STATE & LOADERS
// ─────────────────────────────────────────────────────────────────────────────

let scene, camera, renderer;
let reticle;
let selectionBoxHelper;

const spawnedModels = []; // [{ mesh, price, glbUrl }]
let selectedModelData = null; // Catalog asset data: { glbUrl, price }
let selectedPlacedEntry = null; // Placed 3D object: { mesh, price, glbUrl }

// Enable Three.js network cache
THREE.Cache.enabled = true;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
dracoLoader.preload();

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

const modelCache = {};

// Background preload queue for instant placement
const PRELOAD_CONCURRENCY = 2;
let activePreloads = 0;
const preloadQueue = [];

function preloadModel(glbUrl, { priority = false } = {}) {
    if (!glbUrl || modelCache[glbUrl]) return modelCache[glbUrl];

    const promise = new Promise((resolve, reject) => {
        const job = () => {
            activePreloads++;
            gltfLoader.load(
                glbUrl,
                (gltf) => {
                    activePreloads--;
                    resolve(gltf.scene);
                    pumpPreloadQueue();
                },
                undefined,
                (err) => {
                    activePreloads--;
                    console.error('[preloadModel] Load error:', err);
                    delete modelCache[glbUrl];
                    reject(err);
                    pumpPreloadQueue();
                }
            );
        };

        if (priority) {
            preloadQueue.unshift(job);
        } else {
            preloadQueue.push(job);
        }
    });

    modelCache[glbUrl] = promise;
    pumpPreloadQueue();
    return promise;
}

function pumpPreloadQueue() {
    while (activePreloads < PRELOAD_CONCURRENCY && preloadQueue.length > 0) {
        const job = preloadQueue.shift();
        job();
    }
}

// CSS Reticle — positioned in DOM, always pixel-perfect at screen center
const cssReticle = document.getElementById('reticle');
const hintEl = document.getElementById('placement-hint');
const placeBtn = document.getElementById('place-btn');
let hasHitSurface = false; // tracks whether a surface has EVER been found (controls dim-vs-hidden)

// Surface-scan gating (inspired by ARKit/Quick Look, tuned to be forgiving):
// an ESTIMATED_SURFACE_PLANE hit is a confirmed, classified surface and locks
// instantly. A raw FEATURE_POINT hit is a noisier single-point depth guess —
// rather than rejecting it outright (which meant the app could hang forever
// "scanning" in dim light or on low-texture surfaces where plane classification
// rarely completes), it's accepted once it's been consistently present for a
// short settle window. `hitStreak` decays gradually on a miss rather than
// resetting to zero, so brief flicker between plane/feature/no-hit doesn't
// restart the settle countdown from scratch.
const MISS_TOLERANCE_FRAMES = 6;
const FEATURE_POINT_SETTLE_FRAMES = 10; // ~0.3–0.4s of consistent tracking at 24–30fps
let missStreak = 0;
let hitStreak = 0;
let surfaceLocked = false;
const SCANNING_HINT = 'Move your device slowly to scan for a surface…';
const DETECTING_HINT = 'Hold steady, locking onto surface…';
const READY_HINT = "Aim at a surface and tap 'Place Model'";

// Gesture thresholds for moving/rotating a selected placed model.
const TAP_MOVE_THRESHOLD = 10; // px — below this, a touch is a tap, not a drag

// Raycasting for Model Selection
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLACED MODEL SELECTION & HIGHLIGHTING
// ─────────────────────────────────────────────────────────────────────────────

function selectPlacedModel(entry) {
    selectedPlacedEntry = entry;
    const deleteBtn = document.getElementById('delete-selected-btn');

    if (entry) {
        selectionBoxHelper.setFromObject(entry.mesh);
        selectionBoxHelper.visible = true;
        deleteBtn.style.display = 'inline-flex';
    } else {
        selectionBoxHelper.visible = false;
        deleteBtn.style.display = 'none';
    }
}

function handleCanvasTap(clientX, clientY) {
    if (!camera || !scene) return;

    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const targetMeshes = spawnedModels.map(item => item.mesh);
    const intersects = raycaster.intersectObjects(targetMeshes, true);

    if (intersects.length > 0) {
        let topObj = intersects[0].object;
        while (topObj.parent && topObj.parent !== scene) {
            topObj = topObj.parent;
        }

        const matchedEntry = spawnedModels.find(e => e.mesh === topObj);
        if (matchedEntry) {
            selectPlacedModel(matchedEntry);
            return;
        }
    }

    // Tapped open space -> deselect placed model
    selectPlacedModel(null);
}

// Moves the currently-selected placed model by re-running a live hit test at
// the given screen point, so it always tracks exactly where the finger is
// touching the real surface — not an arbitrary fixed-height plane.
function moveSelectedModel(clientX, clientY) {
    if (!selectedPlacedEntry || !window.XR8) return;

    const nx = clientX / window.innerWidth;
    const ny = clientY / window.innerHeight;
    const results = XR8.XrController.hitTest(nx, ny, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);
    const { hit } = pickBestHit(results);
    if (!hit) return;

    selectedPlacedEntry.mesh.position.set(hit.position.x, hit.position.y, hit.position.z);
    if (selectionBoxHelper.visible) {
        selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
    }
}

function angleBetweenTouches(touches) {
    return Math.atan2(touches[1].clientY - touches[0].clientY, touches[1].clientX - touches[0].clientX);
}

// Classifies a plane hit's orientation from its rotation, the same distinction
// ARKit/Quick Look makes between horizontal (floor, tabletop) and vertical
// (wall) surfaces. We rotate the world up vector (0,1,0) by the hit's own
// rotation to get the plane's normal, then check how aligned it is with
// world-up: near 1 -> horizontal, near 0 -> vertical, in between -> angled.
const _upVec = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _reusableQuat = new THREE.Quaternion();
function classifyPlaneOrientation(rotation) {
    const q = _reusableQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
    _upVec.set(0, 1, 0).applyQuaternion(q);
    const alignment = Math.abs(_upVec.dot(_worldUp));
    if (alignment > 0.8) return 'horizontal';
    if (alignment < 0.35) return 'vertical';
    return 'angled';
}

// Picks the best hit test result for the current frame, preferring — in
// order — a horizontal plane (floor/tabletop, the common furniture case),
// then a vertical plane (wall), then any other classified plane, and only
// falling back to a raw feature point if no classified surface is present.
function pickBestHit(hitTestResults) {
    const planeHits = hitTestResults?.filter((h) => h.type === 'ESTIMATED_SURFACE_PLANE') ?? [];
    if (planeHits.length > 0) {
        const horizontal = planeHits.find((h) => classifyPlaneOrientation(h.rotation) === 'horizontal');
        if (horizontal) return { hit: horizontal, isPlane: true };

        const vertical = planeHits.find((h) => classifyPlaneOrientation(h.rotation) === 'vertical');
        if (vertical) return { hit: vertical, isPlane: true };

        return { hit: planeHits[0], isPlane: true };
    }

    const featureHit = hitTestResults?.find((h) => h.type === 'FEATURE_POINT');
    return featureHit ? { hit: featureHit, isPlane: false } : { hit: null, isPlane: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 8TH WALL PIPELINE LOGIC (SLAM ENGINE)
// ─────────────────────────────────────────────────────────────────────────────

const arStagingPipelineModule = () => {
    let touchStartX = 0;
    let touchStartY = 0;

    return {
        name: 'ar-staging-logic',
        onStart: ({ canvas }) => {
            const { scene: xrScene, camera: xrCamera, renderer: xrRenderer } = XR8.Threejs.xrScene();
            scene = xrScene;
            camera = xrCamera;
            renderer = xrRenderer;

            if (renderer && renderer.setPixelRatio) {
                renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            }

            // Scene Lighting
            const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1.5);
            light.position.set(0.5, 1, 0.25);
            scene.add(light);

            const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
            dirLight.position.set(1, 4, 2);
            scene.add(dirLight);

            // We use a CSS reticle (always screen-center) instead of a 3D mesh.
            // A hidden THREE.Object3D acts as the placement anchor for hit test results.
            reticle = new THREE.Object3D();
            scene.add(reticle);

            // Add selection box helper for highlighting 3D models
            selectionBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x007aff);
            selectionBoxHelper.visible = false;
            scene.add(selectionBoxHelper);

            // Pointer/Touch Listeners for selection, drag-to-move, and pinch-to-rotate
            let isDragging = false;
            let isRotating = false;
            let rotateStartAngle = 0;
            let rotateStartY = 0;

            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                    isDragging = false;
                    isRotating = false;
                } else if (e.touches.length === 2 && selectedPlacedEntry) {
                    isRotating = true;
                    isDragging = false;
                    rotateStartAngle = angleBetweenTouches(e.touches);
                    rotateStartY = selectedPlacedEntry.mesh.rotation.y;
                }
            }, { passive: true });

            canvas.addEventListener('touchmove', (e) => {
                if (isRotating && e.touches.length === 2 && selectedPlacedEntry) {
                    const currentAngle = angleBetweenTouches(e.touches);
                    selectedPlacedEntry.mesh.rotation.y = rotateStartY + (currentAngle - rotateStartAngle);
                    if (selectionBoxHelper.visible) {
                        selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
                    }
                    return;
                }

                if (e.touches.length === 1 && selectedPlacedEntry) {
                    const touch = e.touches[0];
                    if (!isDragging) {
                        const dx = touch.clientX - touchStartX;
                        const dy = touch.clientY - touchStartY;
                        if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) {
                            isDragging = true;
                        }
                    }
                    if (isDragging) {
                        moveSelectedModel(touch.clientX, touch.clientY);
                    }
                }
            }, { passive: true });

            canvas.addEventListener('touchend', (e) => {
                if (isRotating) {
                    isRotating = false;
                    return;
                }
                if (isDragging) {
                    isDragging = false;
                    return; // was a drag, not a tap — don't trigger select/deselect
                }
                if (e.changedTouches.length === 1) {
                    const endX = e.changedTouches[0].clientX;
                    const endY = e.changedTouches[0].clientY;

                    // Only count as a tap if touch didn't drag significantly
                    if (Math.hypot(endX - touchStartX, endY - touchStartY) < TAP_MOVE_THRESHOLD) {
                        handleCanvasTap(endX, endY);
                    }
                }
            });

            canvas.addEventListener('click', (e) => {
                // Desktop / Mouse fallback
                handleCanvasTap(e.clientX, e.clientY);
            });

            updatePlacementAvailability(false);
        },
        onUpdate: () => {
            if (!scene) return;

            // Perform hit test straight out from viewport center (0.5, 0.5)
            const hitTestResults = XR8.XrController.hitTest(0.5, 0.5, ['ESTIMATED_SURFACE_PLANE', 'FEATURE_POINT']);

            // Prioritize horizontal (floor/tabletop) then vertical (wall) planes,
            // same as Quick Look, before ever falling back to a raw feature point.
            const { hit, isPlane: planeHit } = pickBestHit(hitTestResults);

            if (hit) {
                missStreak = 0;

                // A classified plane is trusted immediately. A feature point
                // still has to earn trust by building up its settle streak.
                hitStreak = planeHit ? FEATURE_POINT_SETTLE_FRAMES : Math.min(hitStreak + 1, FEATURE_POINT_SETTLE_FRAMES);

                // Update invisible anchor so placement uses the live world position
                const p = hit.position;
                const r = hit.rotation;
                reticle.position.set(p.x, p.y, p.z);
                reticle.quaternion.set(r.x, r.y, r.z, r.w);

                const isSettled = hitStreak >= FEATURE_POINT_SETTLE_FRAMES;

                cssReticle.style.display = 'flex';
                cssReticle.style.opacity = isSettled ? '1' : '0.5';

                if (isSettled) {
                    hasHitSurface = true;
                    if (!surfaceLocked) {
                        surfaceLocked = true;
                        updatePlacementAvailability(true);
                    }
                } else if (selectedModelData) {
                    hintEl.textContent = DETECTING_HINT;
                }
            } else {
                missStreak += 1;
                // Decay gradually rather than resetting to zero instantly, so
                // brief flicker between plane/feature/no-hit doesn't force the
                // settle countdown to restart from scratch.
                hitStreak = Math.max(0, hitStreak - 1);

                // Tolerate a handful of dropped frames before treating the
                // surface as lost, so brief tracking hiccups don't flicker
                // the reticle or the Place button in and out.
                if (missStreak > MISS_TOLERANCE_FRAMES) {
                    // Dim but keep visible so it doesn't flash in/out constantly
                    cssReticle.style.opacity = hasHitSurface ? '0.35' : '0';

                    if (surfaceLocked) {
                        surfaceLocked = false;
                        updatePlacementAvailability(false);
                    }
                }
            }

            // Keep selection bounding box aligned with selected object
            if (selectedPlacedEntry && selectionBoxHelper.visible) {
                selectionBoxHelper.setFromObject(selectedPlacedEntry.mesh);
            }
        }
    };
};

const onxrloaded = () => {
    XR8.addCameraPipelineModules([
        XR8.GlTextureRenderer.pipelineModule(),       // Camera feed renderer
        XR8.Threejs.pipelineModule(),                 // Three.js sync
        XR8.XrController.pipelineModule(),            // SLAM tracking engine
        window.XRExtras.AlmostThere.pipelineModule(), // Loading UI
        window.XRExtras.FullWindowCanvas.pipelineModule(),
        window.XRExtras.Loading.pipelineModule(),
        window.XRExtras.RuntimeError.pipelineModule(),
        arStagingPipelineModule(),                    // App Logic
    ]);

    XR8.run({ canvas: document.getElementById('camera-canvas') });
};

if (window.XR8) {
    onxrloaded();
} else {
    window.addEventListener('xrloaded', onxrloaded);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UI CONTROLS & DYNAMIC BUTTON HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

function updateBudget() {
    const total = spawnedModels.reduce((sum, item) => sum + (item.price || 0), 0);
    document.getElementById('budget-value').textContent = `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Reflects current surface-lock state in the Place button (disabled/dimmed
// until a real surface is confirmed) and, if a catalog item is selected,
// in the placement hint text.
function updatePlacementAvailability(ready) {
    placeBtn.disabled = !ready;
    placeBtn.style.opacity = ready ? '1' : '0.4';
    placeBtn.style.pointerEvents = ready ? 'auto' : 'none';

    if (selectedModelData) {
        hintEl.textContent = ready ? READY_HINT : SCANNING_HINT;
    }
}

// Hamburger Drawer Toggle
const catalogDrawer = document.getElementById('catalog-drawer');
const hamburgerBtn = document.getElementById('hamburger-btn');
const closeDrawerBtn = document.getElementById('close-drawer-btn');

function toggleDrawer(open) {
    if (open === undefined) {
        catalogDrawer.classList.toggle('collapsed');
    } else if (open) {
        catalogDrawer.classList.remove('collapsed');
    } else {
        catalogDrawer.classList.add('collapsed');
    }
}

hamburgerBtn.addEventListener('click', () => toggleDrawer());
closeDrawerBtn.addEventListener('click', () => toggleDrawer(false));

// Clear All Models
document.getElementById('clear-btn').addEventListener('click', () => {
    selectPlacedModel(null);
    spawnedModels.forEach(entry => scene.remove(entry.mesh));
    spawnedModels.length = 0;
    updateBudget();
});

// Dynamic Delete Button Action
document.getElementById('delete-selected-btn').addEventListener('click', () => {
    if (!selectedPlacedEntry) return;

    const entryToDelete = selectedPlacedEntry;
    selectPlacedModel(null);

    scene.remove(entryToDelete.mesh);
    entryToDelete.mesh.traverse((node) => {
        if (node.isMesh) {
            node.geometry?.dispose();
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            mats.forEach(m => m?.dispose());
        }
    });

    const idx = spawnedModels.indexOf(entryToDelete);
    if (idx !== -1) {
        spawnedModels.splice(idx, 1);
    }
    updateBudget();
});

// Dynamic Place Button Action
placeBtn.addEventListener('click', () => {
    // Guard against placement before a real surface has been confirmed —
    // without this check, a tap before tracking locks on would place the
    // model at whatever stale/default transform `reticle` currently holds.
    if (selectedModelData && surfaceLocked) {
        spawnModelAtReticle(selectedModelData);
    }
});

function spawnModelAtReticle(modelData) {
    const glbUrl = modelData.glbUrl;

    // Flash the CSS reticle white as placement feedback
    cssReticle.classList.add('flash');
    setTimeout(() => cssReticle.classList.remove('flash'), 200);

    // Snapshot the anchor's world position at the moment of the tap
    const placementPosition = reticle.position.clone();
    const placementQuaternion = reticle.quaternion.clone();

    const templatePromise = modelCache[glbUrl] || preloadModel(glbUrl, { priority: true });

    templatePromise
        .then((template) => addMeshToScene(template.clone(), modelData, placementPosition, placementQuaternion))
        .catch((err) => console.error('[spawnModel] Load error:', err));
}

function addMeshToScene(mesh, modelData, placementPosition, placementQuaternion) {
    // Some GLBs are authored with an off-center or offset pivot (e.g. the
    // mesh sits far from its own local origin, a common export quirk). If we
    // just set position on the raw mesh, the pivot lands exactly where we
    // want but the visible geometry can appear anywhere relative to it —
    // which is what caused models to spawn "in the air" or seemingly
    // off-screen. Wrapping in a group and re-centering the mesh inside it
    // forces the model's actual bounding box to sit exactly at the
    // placement point every time, regardless of the source asset's pivot.
    const wrapper = new THREE.Group();
    wrapper.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    if (isFinite(box.min.x) && isFinite(box.max.x)) {
        const centerX = (box.min.x + box.max.x) / 2;
        const centerZ = (box.min.z + box.max.z) / 2;
        mesh.position.x -= centerX;
        mesh.position.z -= centerZ;
        mesh.position.y -= box.min.y; // rest the model's base on the surface, not its raw origin
    }

    wrapper.position.copy(placementPosition || reticle.position);

    // Extract only Y rotation so model stays upright on the floor plane
    const euler = new THREE.Euler().setFromQuaternion(placementQuaternion || reticle.quaternion, 'YXZ');
    wrapper.rotation.y = euler.y;

    scene.add(wrapper);
    const entry = { mesh: wrapper, price: modelData.price, glbUrl: modelData.glbUrl };
    spawnedModels.push(entry);

    // Hide the placement hint permanently after first model is placed
    if (spawnedModels.length === 1) {
        hintEl.classList.remove('show-hint');
        hintEl.style.display = 'none';
    }

    // Automatically select newly placed model
    selectPlacedModel(entry);
    updateBudget();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FIREBASE CATALOG INTEGRATION
// ─────────────────────────────────────────────────────────────────────────────

const firebaseConfig = {
    apiKey: 'AIzaSyC_3E_BmitmKo9QSKShPMjQePGrz9LmrWY',
    authDomain: 'shot47-database.firebaseapp.com',
    projectId: 'shot47-database',
    storageBucket: 'shot47-database.firebasestorage.app',
    messagingSenderId: '77237094269',
    appId: '1:77237094269:web:a90a6c6239cb66e3102e14',
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

const registry = { furniture: [], carpets: [], decor: [] };
let activeCategory = 'furniture';

const collectionMap = {
    furniture: 'furniture_models',
    carpets: 'carpet_models',
    decor: 'decor_models',
};

async function resolveUrl(pathOrUrl, folder) {
    if (!pathOrUrl) return null;
    if (pathOrUrl.startsWith('http')) return pathOrUrl;
    return getDownloadURL(ref(storage, `${folder}/${pathOrUrl}`));
}

function selectCatalogModel(card, assetData) {
    document.querySelectorAll('.catalog-item').forEach(el => el.classList.remove('selected'));
    card.classList.add('selected');
    selectedModelData = assetData;

    // Show place button & placement guidance hint, reflecting current tracking state
    placeBtn.style.display = 'inline-flex';
    hintEl.classList.add('show-hint');
    updatePlacementAvailability(surfaceLocked);
}

function renderCatalog(category) {
    const list = document.getElementById('catalog-list');
    list.innerHTML = '';
    const assets = registry[category] ?? [];

    if (assets.length === 0) {
        list.innerHTML = '<div class="empty-notice">Updating digital catalog…</div>';
        return;
    }

    assets.forEach((asset) => {
        const card = document.createElement('div');
        card.className = 'catalog-item state-loading';
        card.innerHTML = `
            <div class="thumb-wrapper"><img class="catalog-thumb" alt="${asset.title}" /></div>
            <div class="card-meta"><span>${asset.title}</span></div>
        `;
        list.appendChild(card);

        const img = card.querySelector('.catalog-thumb');
        if (asset.imgName) {
            resolveUrl(asset.imgName, 'models/thumbnails')
                .then((url) => { img.src = url; })
                .catch(() => { });
        }

        resolveUrl(asset.glbName, 'models/glb')
            .then((glbUrl) => {
                card.classList.remove('state-loading');
                const assetData = { glbUrl, price: asset.price };
                const isFirstCard = list.children[0] === card;

                preloadModel(glbUrl, { priority: isFirstCard });

                card.addEventListener('click', () => {
                    selectCatalogModel(card, assetData);
                    preloadModel(glbUrl, { priority: true });
                });

                if (!selectedModelData && isFirstCard) {
                    selectCatalogModel(card, assetData);
                }
            })
            .catch(() => {
                card.classList.remove('state-loading');
                card.style.opacity = '0.3';
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
                    title: d.title ?? 'Unnamed',
                    glbName: d.glb,
                    imgName: d.img ?? null,
                    price: d.price ?? 349.00
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

initCatalogSync();