import * as ThreeModule from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const THREE = { ...ThreeModule, OrbitControls };

let scene, camera, renderer, controls, raycaster, mouse, ground, grid;
        let worldObjects = [];
        let debris = [];
        let fireParticles = [];
        let currentBrush = 'house';
        // Multi-target system: Shift+click with a destroy weapon queues positions
        let multiTargets = []; // Array of THREE.Vector3
        let multiTargetMarkers = []; // Visual markers in the scene
        const gravityConstant = 0.015;
        const WORLD_SIZE = 200;

        let singularityPoint = null;
        let tornadoes = []; // array of { mesh, point, age }
        let tsunamis = []; // array of { mesh, position, dir, age, lifeMax }
        let volcanoes = []; // array of { mesh, point, age, lifeMax, lavaPool }
        let lavaBombs = []; // airborne lava projectiles
        let lavaStreams = []; // active lava streams from clicks (drops + growing pool)
        let cooledLavaPools = []; // orphaned cooled pools after stream expires
        let cyclopses = []; // array of { mesh, target, age, lifeMax, ... }

        // Day/night cycle: phase 0..1 where 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
        let dayPhase = 0.35; // start in morning
        const DAY_LENGTH = 18000; // frames for full cycle (~5 min at 60fps)
        let dayNightMode = 'auto'; // 'auto', 'day', or 'night'
        let windowsAreNightMode = false; // track so we only update when state flips

        // Resident auto-spawner
        let residentSpawnTimer = 0;

        function init() {
            scene = new THREE.Scene();
            scene.background = new THREE.Color(0x0f172a);
            scene.fog = new THREE.FogExp2(0x0f172a, 0.003);

            camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 3000);
            camera.position.set(220, 180, 220);

            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            renderer.toneMapping = THREE.ReinhardToneMapping;
            renderer.toneMappingExposure = 1.2;
            (document.getElementById('simulator-canvas-root') || document.body).appendChild(renderer.domElement);

            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.maxPolarAngle = Math.PI / 2.1;

            // Lighting (globals so day/night cycle can modulate them)
            window.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
            scene.add(window.hemiLight);

            window.sun = new THREE.DirectionalLight(0xffffff, 1.5);
            window.sun.position.set(100, 300, 100);
            window.sun.castShadow = true;
            window.sun.shadow.mapSize.width = 2048;
            window.sun.shadow.mapSize.height = 2048;
            window.sun.shadow.camera.left = -400;
            window.sun.shadow.camera.right = 400;
            window.sun.shadow.camera.top = 400;
            window.sun.shadow.camera.bottom = -400;
            scene.add(window.sun);

            window.ambient = new THREE.AmbientLight(0xffffff, 0.4);
            scene.add(window.ambient);

            window.fillLight = new THREE.PointLight(0xffffff, 1.0, 600);
            window.fillLight.position.set(0, 100, 0);
            scene.add(window.fillLight);

            // Ground
            const groundGeo = new THREE.PlaneGeometry(2000, 2000);
            ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ color: 0x1e293b }));
            ground.rotation.x = -Math.PI / 2;
            ground.receiveShadow = true;
            scene.add(ground);

            grid = new THREE.GridHelper(1000, 100, 0x475569, 0x334155);
            grid.position.y = 0.05;
            scene.add(grid);

            // Border
            const borderGeo = new THREE.CylinderGeometry(WORLD_SIZE, WORLD_SIZE, 80, 64, 1, true);
            const borderMat = new THREE.MeshBasicMaterial({
                color: 0x60a5fa, wireframe: true, transparent: true, opacity: 0.2, side: THREE.DoubleSide
            });
            const border = new THREE.Mesh(borderGeo, borderMat);
            border.position.y = 40;
            scene.add(border);

            raycaster = new THREE.Raycaster();
            mouse = new THREE.Vector2();

            window.addEventListener('pointerdown', handlePointerDown);
            window.addEventListener('pointermove', handlePointerMove);
            window.addEventListener('pointerup', handlePointerUp);
            window.addEventListener('resize', onWindowResize);
            setupUI();
            spawnGrass();
            animate();
        }

        // Project a screen point onto the ground plane
        function screenToGround(e) {
            mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            const intersects = raycaster.intersectObject(ground);
            return intersects.length > 0 ? intersects[0].point : null;
        }

        function isUITap(e) {
            return e.target.closest('#toolbar') || e.target.closest('#header');
        }

        // Build/destroy tools
        const DESTROY_TOOLS = new Set(['fire','vortex','quake','tsunami','volcano','lavaflood','napalm','cluster','nuke','blackhole','meteor','cracker','leviathan','kraken']);

        function addMultiTarget(pt) {
            multiTargets.push(pt.clone());
            // Visual ring marker at the position
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(2.5, 0.3, 8, 24),
                new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85 })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.copy(pt);
            ring.position.y = 0.25;
            // Pulsing number label sphere
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(0.6, 10, 8),
                new THREE.MeshBasicMaterial({ color: 0xff3b30 })
            );
            dot.position.copy(pt);
            dot.position.y = 1.2;
            scene.add(ring);
            scene.add(dot);
            multiTargetMarkers.push(ring, dot);
            showMessage(`${multiTargets.length} target${multiTargets.length > 1 ? 's' : ''} selected — click to strike all`);
        }

        function clearMultiTargets() {
            multiTargetMarkers.forEach(m => scene.remove(m));
            multiTargetMarkers = [];
            multiTargets = [];
        }

        function fireMultiTargets(type) {
            if (multiTargets.length === 0) return;
            multiTargets.forEach((pt, i) => {
                // Stagger each strike by 80ms so they don't all fire simultaneously
                setTimeout(() => executeWeapon(type, pt), i * 80);
            });
            const count = multiTargets.length;
            clearMultiTargets();
            showMessage(`Striking ${count} targets!`);
        }

        function handlePointerDown(e) {
            if (gameMode === 'survival') return;
            if (gameMode === 'construction') return; // no placing in construction mode
            if (isUITap(e)) return;
            if (!currentBrush) return;

            // If we have pending multi-targets and user clicks WITHOUT shift, fire them all
            if (multiTargets.length > 0 && !e.shiftKey && DESTROY_TOOLS.has(currentBrush)) {
                const pt = screenToGround(e);
                if (pt) {
                    addMultiTarget(pt); // add the final click too
                    fireMultiTargets(currentBrush);
                } else {
                    fireMultiTargets(currentBrush);
                }
                return;
            }

            // Eraser: raycast against world objects, remove the one clicked
            if (currentBrush === 'eraser') {
                mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
                mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
                raycaster.setFromCamera(mouse, camera);
                const hits = raycaster.intersectObjects(worldObjects, true);
                if (hits.length > 0) {
                    let target = hits[0].object;
                    while (target && !worldObjects.includes(target)) {
                        target = target.parent;
                    }
                    if (target) {
                        scene.remove(target);
                        const idx = worldObjects.indexOf(target);
                        if (idx >= 0) worldObjects.splice(idx, 1);
                        showMessage('Erased');
                        return;
                    }
                }
                const riverHits = raycaster.intersectObjects(rivers, false);
                if (riverHits.length > 0) {
                    const r = riverHits[0].object;
                    scene.remove(r);
                    r.geometry.dispose();
                    r.material.dispose();
                    const idx = rivers.indexOf(r);
                    if (idx >= 0) rivers.splice(idx, 1);
                    showMessage('River erased');
                    return;
                }
                const volcMeshes = volcanoes.map(v => v.mesh);
                const volcHits = raycaster.intersectObjects(volcMeshes, true);
                if (volcHits.length > 0) {
                    let hit = volcHits[0].object;
                    while (hit && !volcMeshes.includes(hit)) hit = hit.parent;
                    if (hit) {
                        const vIdx = volcMeshes.indexOf(hit);
                        if (vIdx >= 0) {
                            despawnVolcano(volcanoes[vIdx]);
                            volcanoes.splice(vIdx, 1);
                            showMessage('Volcano erased');
                            return;
                        }
                    }
                }
                return;
            }

            if (currentBrush === 'river') {
                const pt = screenToGround(e);
                if (!pt) return;
                isDrawingRiver = true;
                riverPath = [pt];
                controls.enabled = false;
                e.preventDefault();
                return;
            }

            const pt = screenToGround(e);
            if (!pt) return;

            if (['house', 'skyscraper', 'tree', 'human', 'builder', 'invader', 'animal', 'mountain'].includes(currentBrush)) {
                placeObject(currentBrush, pt);
            } else if (DESTROY_TOOLS.has(currentBrush)) {
                if (e.shiftKey) {
                    // Shift+click: queue this position for multi-strike
                    addMultiTarget(pt);
                } else {
                    // Normal click: fire immediately (clear any stale targets first)
                    clearMultiTargets();
                    executeWeapon(currentBrush, pt);
                }
            }
        }

        function handlePointerMove(e) {
            if (!isDrawingRiver) return;
            const pt = screenToGround(e);
            if (!pt) return;
            // Add to path only if moved enough
            const last = riverPath[riverPath.length - 1];
            if (last.distanceTo(pt) > 3) {
                riverPath.push(pt);
                // Update preview
                if (riverPreview) {
                    scene.remove(riverPreview);
                    riverPreview.geometry.dispose();
                    riverPreview.material.dispose();
                }
                if (riverPath.length >= 2) {
                    riverPreview = buildRiverFromPath(riverPath);
                    if (riverPreview) {
                        riverPreview.material.opacity = 0.5;
                        scene.add(riverPreview);
                    }
                }
            }
        }

        function handlePointerUp(e) {
            if (isDrawingRiver) {
                commitRiverPath();
                isDrawingRiver = false;
                controls.enabled = true;
            }
        }

        // --- HELPER: store original colors so we can char them when burning ---
        function storeOriginalColors(group) {
            group.traverse(child => {
                if (child.isMesh && child.material && child.material.color) {
                    child.userData.originalColor = child.material.color.getHex();
                }
            });
        }

        // ===== PROCEDURAL HOUSE BUILDER =====
        // Each house picks a coherent style, then generates features within it.
        const HOUSE_STYLES = ['cottage', 'modern', 'cabin', 'manor', 'tower', 'bungalow', 'townhouse'];

        const STYLE_PALETTES = {
            cottage:    { walls: [0xfef3c7, 0xfed7aa, 0xfde68a, 0xf5e6c8], roofs: [0x991b1b, 0x7f1d1d, 0x854d0e], trim: 0x44403c },
            modern:     { walls: [0xf1f5f9, 0xe2e8f0, 0xfafafa, 0xd6d3d1], roofs: [0x1e293b, 0x27272a, 0x18181b], trim: 0x0f172a },
            cabin:      { walls: [0x78350f, 0x92400e, 0x713f12, 0x57534e], roofs: [0x1c1917, 0x44403c, 0x292524], trim: 0x1c1917 },
            manor:      { walls: [0xa8a29e, 0xd6d3d1, 0xc7c4be, 0xe7e5e4], roofs: [0x1e1b4b, 0x312e81, 0x064e3b], trim: 0x44403c },
            tower:      { walls: [0xa3a3a3, 0xd4d4d4, 0xb8b8b8], roofs: [0x991b1b, 0x1e3a8a, 0x064e3b], trim: 0x262626 },
            bungalow:   { walls: [0xfecaca, 0xfbcfe8, 0xddd6fe, 0xa7f3d0, 0xfde68a], roofs: [0x9a3412, 0x7c2d12, 0x431407], trim: 0xffffff },
            townhouse:  { walls: [0x7c2d12, 0x9a3412, 0x6b21a8, 0x1e3a8a, 0x064e3b], roofs: [0x1c1917, 0x292524], trim: 0xfafaf9 }
        };

        function pickFromArray(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

        function makeWindow(width, height) {
            // Frame
            const frameMat = new THREE.MeshStandardMaterial({ color: 0x1c1917 });
            const frame = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.15), frameMat);
            // Glass — randomly lit. Tag so day/night cycle can toggle emissive.
            const lit = Math.random() < 0.55;
            const glassMat = new THREE.MeshStandardMaterial({
                color: lit ? 0xfef3c7 : 0x1e293b,
                emissive: lit ? 0xfde047 : 0x000000,
                emissiveIntensity: lit ? 0.6 : 0,
                transparent: true,
                opacity: lit ? 0.95 : 0.7
            });
            const glass = new THREE.Mesh(new THREE.BoxGeometry(width * 0.85, height * 0.85, 0.05), glassMat);
            glass.position.z = 0.08;
            // Tag for day/night system
            glass.userData.isWindow = true;
            glass.userData.windowLit = lit; // whether this window is "occupied" (randomly assigned)
            // Crossbars
            const barMat = new THREE.MeshStandardMaterial({ color: 0x1c1917 });
            const hBar = new THREE.Mesh(new THREE.BoxGeometry(width * 0.85, 0.08, 0.06), barMat);
            hBar.position.z = 0.11;
            const vBar = new THREE.Mesh(new THREE.BoxGeometry(0.08, height * 0.85, 0.06), barMat);
            vBar.position.z = 0.11;
            const win = new THREE.Group();
            win.add(frame); win.add(glass); win.add(hBar); win.add(vBar);
            return win;
        }

        function buildHouse(group) {
            const style = pickFromArray(HOUSE_STYLES);
            const palette = STYLE_PALETTES[style];
            const wallColor = pickFromArray(palette.walls);
            const roofColor = pickFromArray(palette.roofs);

            // Style-driven dimensions
            let width, depth, height, stories;
            if (style === 'tower') {
                width = 5 + Math.random() * 1.5;
                depth = width;
                stories = 2 + Math.floor(Math.random() * 2);
                height = 5 * stories;
            } else if (style === 'manor') {
                width = 10 + Math.random() * 4;
                depth = 9 + Math.random() * 3;
                stories = 2;
                height = 5 * stories;
            } else if (style === 'townhouse') {
                width = 5 + Math.random() * 1.5;
                depth = 7 + Math.random() * 2;
                stories = 2 + Math.floor(Math.random() * 2);
                height = 4.5 * stories;
            } else if (style === 'cabin') {
                width = 7 + Math.random() * 2;
                depth = 6 + Math.random() * 2;
                stories = 1;
                height = 5 + Math.random() * 1;
            } else if (style === 'modern') {
                width = 9 + Math.random() * 3;
                depth = 7 + Math.random() * 2;
                stories = 1 + Math.floor(Math.random() * 2);
                height = 4 * stories + 1;
            } else {
                // cottage, bungalow
                width = 7 + Math.random() * 2;
                depth = 6 + Math.random() * 2;
                stories = 1;
                height = 5 + Math.random() * 1;
            }

            const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 });
            const roofMat = new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.7 });
            const trimMat = new THREE.MeshStandardMaterial({ color: palette.trim });

            // === MAIN BODY ===
            const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallMat);
            body.position.y = height / 2;
            body.castShadow = true; body.receiveShadow = true;
            group.add(body);

            // === ROOF ===
            // Pick a roof style coherent with the house style
            let roofType;
            if (style === 'modern') roofType = 'flat';
            else if (style === 'tower') roofType = Math.random() < 0.5 ? 'pyramid' : 'cone';
            else if (style === 'cabin' || style === 'cottage') roofType = 'gabled';
            else if (style === 'manor') roofType = Math.random() < 0.5 ? 'pyramid' : 'gabled';
            else if (style === 'townhouse') roofType = Math.random() < 0.7 ? 'flat' : 'gabled';
            else roofType = pickFromArray(['gabled', 'pyramid']);

            if (roofType === 'flat') {
                // Slight parapet
                const parapet = new THREE.Mesh(
                    new THREE.BoxGeometry(width + 0.3, 0.6, depth + 0.3),
                    roofMat
                );
                parapet.position.y = height + 0.3;
                parapet.castShadow = true;
                group.add(parapet);
            } else if (roofType === 'pyramid') {
                const roofH = 3 + Math.random() * 2;
                const r = new THREE.Mesh(
                    new THREE.ConeGeometry(Math.max(width, depth) * 0.75, roofH, 4),
                    roofMat
                );
                r.position.y = height + roofH / 2;
                r.rotation.y = Math.PI / 4;
                r.castShadow = true;
                group.add(r);
            } else if (roofType === 'cone') {
                const roofH = 4 + Math.random() * 2;
                const r = new THREE.Mesh(
                    new THREE.ConeGeometry(width * 0.7, roofH, 12),
                    roofMat
                );
                r.position.y = height + roofH / 2;
                r.castShadow = true;
                group.add(r);
            } else if (roofType === 'gabled') {
                // Triangular prism: stretched cone with 3 sides isn't ideal; build a custom prism.
                const roofH = 3 + Math.random() * 2;
                const prismShape = new THREE.Shape();
                prismShape.moveTo(-width/2 - 0.3, 0);
                prismShape.lineTo(width/2 + 0.3, 0);
                prismShape.lineTo(0, roofH);
                prismShape.lineTo(-width/2 - 0.3, 0);
                const prismGeo = new THREE.ExtrudeGeometry(prismShape, {
                    depth: depth + 0.6, bevelEnabled: false
                });
                prismGeo.translate(0, 0, -(depth + 0.6) / 2);
                const r = new THREE.Mesh(prismGeo, roofMat);
                r.position.y = height;
                r.castShadow = true;
                group.add(r);
            }

            // === WINDOWS ===
            // Number and arrangement varies by style
            const winColor = wallColor;
            const winRows = stories;
            // Front face: pick 1-3 windows per story depending on width
            const winsPerStoryFront = width > 9 ? 3 : (width > 6 ? 2 : 1);
            const winsPerStorySide = depth > 9 ? 2 : 1;
            const winW = style === 'modern' ? 1.8 : 1.3;
            const winH = style === 'modern' ? 2.2 : 1.4;

            for (let row = 0; row < winRows; row++) {
                const yPos = (row + 0.5) * (height / stories);
                // Front face
                for (let c = 0; c < winsPerStoryFront; c++) {
                    const xPos = -width/2 + (width / (winsPerStoryFront + 1)) * (c + 1);
                    const w = makeWindow(winW, winH);
                    w.position.set(xPos, yPos, depth/2 + 0.05);
                    group.add(w);
                }
                // Back face
                for (let c = 0; c < winsPerStoryFront; c++) {
                    const xPos = -width/2 + (width / (winsPerStoryFront + 1)) * (c + 1);
                    const w = makeWindow(winW, winH);
                    w.position.set(xPos, yPos, -depth/2 - 0.05);
                    w.rotation.y = Math.PI;
                    group.add(w);
                }
                // Side faces
                for (let c = 0; c < winsPerStorySide; c++) {
                    const zPos = -depth/2 + (depth / (winsPerStorySide + 1)) * (c + 1);
                    const wL = makeWindow(winW, winH);
                    wL.position.set(-width/2 - 0.05, yPos, zPos);
                    wL.rotation.y = -Math.PI / 2;
                    group.add(wL);
                    const wR = makeWindow(winW, winH);
                    wR.position.set(width/2 + 0.05, yPos, zPos);
                    wR.rotation.y = Math.PI / 2;
                    group.add(wR);
                }
            }

            // === DOOR (front-facing) ===
            const doorColors = [0x1c1917, 0x7c2d12, 0x064e3b, 0x1e3a8a, 0x991b1b, 0xfafaf9];
            const doorMat = new THREE.MeshStandardMaterial({ color: pickFromArray(doorColors) });
            const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 0.2), doorMat);
            // Place door at random offset along front
            const doorOffset = (Math.random() - 0.5) * Math.max(0, width - 3);
            door.position.set(doorOffset, 1.3, depth/2 + 0.08);
            group.add(door);
            // Door knob
            const knob = new THREE.Mesh(
                new THREE.SphereGeometry(0.08, 6, 6),
                new THREE.MeshStandardMaterial({ color: 0xfbbf24, metalness: 0.7, roughness: 0.3 })
            );
            knob.position.set(doorOffset + 0.6, 1.3, depth/2 + 0.2);
            group.add(knob);

            // === CHIMNEY (some styles only) ===
            let chimneyInfo = null;
            if ((style === 'cottage' || style === 'cabin' || style === 'manor') && roofType !== 'flat' && Math.random() < 0.7) {
                const chimMat = new THREE.MeshStandardMaterial({ color: 0x57534e });
                const chimX = (Math.random() - 0.5) * width * 0.5;
                const chimZ = (Math.random() - 0.5) * depth * 0.5;
                const chim = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3, 0.9), chimMat);
                chim.position.set(chimX, height + 2, chimZ);
                chim.castShadow = true;
                group.add(chim);
                // Chimney top (slightly wider)
                const cap = new THREE.Mesh(
                    new THREE.BoxGeometry(1.1, 0.3, 1.1),
                    new THREE.MeshStandardMaterial({ color: 0x292524 })
                );
                cap.position.set(chimX, height + 3.55, chimZ);
                group.add(cap);
                chimneyInfo = { x: chimX, z: chimZ };
            }

            // === GARAGE/EXTENSION (manor, modern occasionally) ===
            if ((style === 'manor' || style === 'modern') && Math.random() < 0.5) {
                const exW = 4 + Math.random() * 1.5;
                const exH = height * 0.65;
                const exD = 4;
                const ex = new THREE.Mesh(new THREE.BoxGeometry(exW, exH, exD), wallMat);
                const side = Math.random() < 0.5 ? -1 : 1;
                ex.position.set(side * (width/2 + exW/2), exH/2, depth/2 - exD/2);
                ex.castShadow = true;
                group.add(ex);
                // Garage door
                const gDoor = new THREE.Mesh(
                    new THREE.BoxGeometry(exW * 0.75, exH * 0.75, 0.15),
                    new THREE.MeshStandardMaterial({ color: 0xd6d3d1 })
                );
                gDoor.position.set(side * (width/2 + exW/2), exH * 0.4, depth/2 - exD + 0.08);
                group.add(gDoor);
                // Flat roof on extension
                const exRoof = new THREE.Mesh(
                    new THREE.BoxGeometry(exW + 0.2, 0.3, exD + 0.2),
                    roofMat
                );
                exRoof.position.set(side * (width/2 + exW/2), exH + 0.15, depth/2 - exD/2);
                group.add(exRoof);
            }

            // === BALCONY (manor/townhouse second-story occasionally) ===
            if ((style === 'manor' || style === 'townhouse') && stories >= 2 && Math.random() < 0.5) {
                const balcony = new THREE.Mesh(
                    new THREE.BoxGeometry(width * 0.5, 0.2, 1.5),
                    new THREE.MeshStandardMaterial({ color: palette.trim })
                );
                balcony.position.set(0, height * 0.55, depth/2 + 0.75);
                group.add(balcony);
                // Railing posts
                const postMat = new THREE.MeshStandardMaterial({ color: palette.trim });
                for (let p = 0; p < 5; p++) {
                    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), postMat);
                    post.position.set(-width * 0.25 + p * (width * 0.125), height * 0.55 + 0.5, depth/2 + 1.45);
                    group.add(post);
                }
            }

            // === STEPS / PORCH (cottage, bungalow, manor) ===
            if (['cottage', 'bungalow', 'manor'].includes(style) && Math.random() < 0.7) {
                const stepMat = new THREE.MeshStandardMaterial({ color: 0x78716c });
                for (let s = 0; s < 2; s++) {
                    const step = new THREE.Mesh(
                        new THREE.BoxGeometry(2.4 - s * 0.3, 0.25, 0.6 - s * 0.1),
                        stepMat
                    );
                    step.position.set(doorOffset, 0.125 + s * 0.25, depth/2 + 0.4 - s * 0.15);
                    group.add(step);
                }
            }

            // === STORY HP and metadata ===
            const hpScale = 1 + (stories - 1) * 0.5 + (style === 'manor' ? 0.5 : 0) + (style === 'tower' ? 0.3 : 0);
            group.userData.hp = Math.round(300 * hpScale);
            group.userData.maxHp = Math.round(300 * hpScale);
            group.userData.style = style;
            group.userData.dimensions = { width, depth, height, stories };
            group.userData.roofType = roofType;
            group.userData.chimney = chimneyInfo;
            // Approximate footprint for residents (used by pickNearbyTarget)
            group.userData.footprint = Math.max(width, depth);
        }

        // ===== PROCEDURAL SKYSCRAPER BUILDER =====
        function buildSkyscraper(group) {
            // Random tall building parameters
            const baseW = 5 + Math.random() * 4;
            const baseD = 5 + Math.random() * 4;
            const floors = 8 + Math.floor(Math.random() * 14); // 8-21 floors
            const floorHeight = 2.5;
            const totalHeight = floors * floorHeight;

            // Color palettes for skyscrapers
            const palettes = [
                { wall: 0x6b7280, glass: 0x60a5fa, accent: 0x374151 }, // grey + blue glass
                { wall: 0x4b5563, glass: 0x93c5fd, accent: 0x1f2937 }, // darker grey
                { wall: 0xb9a48a, glass: 0xa3d9c0, accent: 0x6b5942 }, // sandstone + green glass
                { wall: 0x1e293b, glass: 0xffffff, accent: 0x0f172a }, // dark + bright reflections
                { wall: 0xc7d2fe, glass: 0x5b6cff, accent: 0x4338ca }, // indigo modern
            ];
            const pal = palettes[Math.floor(Math.random() * palettes.length)];
            const wallMat = new THREE.MeshStandardMaterial({ color: pal.wall, roughness: 0.7 });
            const glassMat = new THREE.MeshStandardMaterial({
                color: pal.glass,
                roughness: 0.15,
                metalness: 0.5,
                emissive: pal.glass,
                emissiveIntensity: 0.2
            });
            const accentMat = new THREE.MeshStandardMaterial({ color: pal.accent, roughness: 0.6 });

            // Main body — could be a single tower or stepped (with setbacks)
            const stepped = Math.random() < 0.5 && floors > 12;
            if (stepped) {
                // Tower base wider, top narrower
                const stepFloor = Math.floor(floors * 0.55);
                const baseHeight = stepFloor * floorHeight;
                const topHeight = (floors - stepFloor) * floorHeight;
                // Base
                const baseBox = new THREE.Mesh(
                    new THREE.BoxGeometry(baseW, baseHeight, baseD),
                    wallMat
                );
                baseBox.position.y = baseHeight / 2;
                baseBox.castShadow = true;
                baseBox.receiveShadow = true;
                group.add(baseBox);
                // Top
                const topW = baseW * 0.7;
                const topD = baseD * 0.7;
                const topBox = new THREE.Mesh(
                    new THREE.BoxGeometry(topW, topHeight, topD),
                    wallMat
                );
                topBox.position.y = baseHeight + topHeight / 2;
                topBox.castShadow = true;
                group.add(topBox);
                // Glass band on top of base (visual accent)
                const band = new THREE.Mesh(
                    new THREE.BoxGeometry(baseW * 1.02, 0.3, baseD * 1.02),
                    accentMat
                );
                band.position.y = baseHeight + 0.15;
                group.add(band);
            } else {
                // Simple rectangular tower
                const tower = new THREE.Mesh(
                    new THREE.BoxGeometry(baseW, totalHeight, baseD),
                    wallMat
                );
                tower.position.y = totalHeight / 2;
                tower.castShadow = true;
                tower.receiveShadow = true;
                group.add(tower);
            }

            // Window grid using a single instanced mesh per face (4 faces)
            const windowGeo = new THREE.PlaneGeometry(0.8, 1.2);
            const windowsPerFloor = 4; // approximate
            // Faces (front/back/left/right) — for each, a grid of small lit windows
            const faces = [
                { axis: 'z', sign: +1, w: baseW, d: baseD },
                { axis: 'z', sign: -1, w: baseW, d: baseD },
                { axis: 'x', sign: +1, w: baseD, d: baseW },
                { axis: 'x', sign: -1, w: baseD, d: baseW },
            ];
            faces.forEach(face => {
                for (let f = 0; f < floors; f++) {
                    for (let w = 0; w < windowsPerFloor; w++) {
                        const lit = Math.random() < 0.65;
                        const win = new THREE.Mesh(
                            windowGeo,
                            (lit ? glassMat : accentMat).clone() // clone so we can set emissive independently
                        );
                        win.userData.isWindow = true;
                        win.userData.windowLit = lit;
                        const fracX = (w + 0.5) / windowsPerFloor;
                        const xPos = (fracX - 0.5) * face.w * 0.9;
                        const yPos = (f + 0.5) * floorHeight;
                        if (face.axis === 'z') {
                            win.position.set(xPos, yPos, face.sign * (face.d / 2 + 0.02));
                            if (face.sign < 0) win.rotation.y = Math.PI;
                        } else {
                            win.position.set(face.sign * (face.d / 2 + 0.02), yPos, xPos);
                            win.rotation.y = face.sign > 0 ? -Math.PI / 2 : Math.PI / 2;
                        }
                        group.add(win);
                    }
                }
            });

            // Antenna / spire on top — adds variety
            if (Math.random() < 0.6) {
                const antenna = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.15, 0.3, 4 + Math.random() * 4, 6),
                    accentMat
                );
                antenna.position.y = totalHeight + (antenna.geometry.parameters.height / 2);
                antenna.castShadow = true;
                group.add(antenna);
                // Red blinker (just a sphere, doesn't actually blink)
                const blinker = new THREE.Mesh(
                    new THREE.SphereGeometry(0.18, 8, 6),
                    new THREE.MeshStandardMaterial({
                        color: 0xff2200,
                        emissive: 0xff0000,
                        emissiveIntensity: 1.5
                    })
                );
                blinker.position.y = totalHeight + antenna.geometry.parameters.height + 0.18;
                group.add(blinker);
            }

            // Optional rooftop equipment (HVAC boxes)
            const eqCount = 1 + Math.floor(Math.random() * 4);
            for (let i = 0; i < eqCount; i++) {
                const eq = new THREE.Mesh(
                    new THREE.BoxGeometry(0.6 + Math.random() * 0.8, 0.5 + Math.random() * 0.4, 0.6 + Math.random() * 0.8),
                    accentMat
                );
                const ex = (Math.random() - 0.5) * (baseW - 1);
                const ez = (Math.random() - 0.5) * (baseD - 1);
                eq.position.set(ex, totalHeight + eq.geometry.parameters.height / 2, ez);
                group.add(eq);
            }

            // Random Y rotation
            group.rotation.y = Math.random() * Math.PI * 2;

            group.userData.hp = 600 + Math.random() * 400; // tough but not invincible
            group.userData.maxHp = group.userData.hp;
            group.userData.footprint = Math.max(baseW, baseD) * 1.1;
            group.userData.totalHeight = totalHeight;
        }

        // ===== PROCEDURAL TREE BUILDER =====
        const TREE_SPECIES = ['pine', 'oak', 'birch', 'maple', 'willow', 'cypress', 'cherry', 'dead'];

        // Hue ranges per species — picked once per tree, slight variation
        function pickGreenHue() {
            // Pick varied greens: forest, lime, sage, olive
            const greens = [0x166534, 0x14532d, 0x15803d, 0x16a34a, 0x22c55e, 0x4d7c0f, 0x65a30d, 0x365314];
            return greens[Math.floor(Math.random() * greens.length)];
        }

        function jitterColor(hex, amount = 0.08) {
            // Slight perturbation of an RGB color
            const c = new THREE.Color(hex);
            c.r = Math.max(0, Math.min(1, c.r + (Math.random() - 0.5) * amount));
            c.g = Math.max(0, Math.min(1, c.g + (Math.random() - 0.5) * amount));
            c.b = Math.max(0, Math.min(1, c.b + (Math.random() - 0.5) * amount));
            return c.getHex();
        }

        function buildTree(group) {
            const species = TREE_SPECIES[Math.floor(Math.random() * TREE_SPECIES.length)];

            // Common: trunk metadata
            let trunkColor, trunkHeight, trunkRadiusBase, trunkRadiusTop;
            let foliageColor, hp;

            if (species === 'pine') {
                trunkColor = 0x4d2916;
                trunkHeight = 6 + Math.random() * 4;
                trunkRadiusBase = 0.7;
                trunkRadiusTop = 0.4;
                foliageColor = jitterColor(0x14532d, 0.1);
                hp = 110;
            } else if (species === 'oak') {
                trunkColor = 0x6b4423;
                trunkHeight = 4 + Math.random() * 2;
                trunkRadiusBase = 1.1 + Math.random() * 0.4;
                trunkRadiusTop = 0.9;
                foliageColor = jitterColor(0x166534, 0.1);
                hp = 140;
            } else if (species === 'birch') {
                trunkColor = 0xefefef;
                trunkHeight = 7 + Math.random() * 3;
                trunkRadiusBase = 0.4;
                trunkRadiusTop = 0.3;
                foliageColor = jitterColor(0x84cc16, 0.1);
                hp = 80;
            } else if (species === 'maple') {
                trunkColor = 0x57370e;
                trunkHeight = 5 + Math.random() * 2;
                trunkRadiusBase = 0.8;
                trunkRadiusTop = 0.6;
                // Random: green or autumn colors
                if (Math.random() < 0.5) {
                    foliageColor = jitterColor(0x16a34a, 0.1);
                } else {
                    const autumn = [0xea580c, 0xdc2626, 0xf59e0b, 0xb45309, 0xc2410c];
                    foliageColor = autumn[Math.floor(Math.random() * autumn.length)];
                }
                hp = 110;
            } else if (species === 'willow') {
                trunkColor = 0x57534e;
                trunkHeight = 4 + Math.random() * 2;
                trunkRadiusBase = 0.9;
                trunkRadiusTop = 0.7;
                foliageColor = jitterColor(0x4d7c0f, 0.1);
                hp = 100;
            } else if (species === 'cypress') {
                trunkColor = 0x44403c;
                trunkHeight = 9 + Math.random() * 4;
                trunkRadiusBase = 0.5;
                trunkRadiusTop = 0.3;
                foliageColor = jitterColor(0x14532d, 0.06);
                hp = 95;
            } else if (species === 'cherry') {
                trunkColor = 0x4a3728;
                trunkHeight = 4 + Math.random() * 2;
                trunkRadiusBase = 0.5;
                trunkRadiusTop = 0.4;
                const blossoms = [0xfbcfe8, 0xf9a8d4, 0xfecaca, 0xfef3c7];
                foliageColor = blossoms[Math.floor(Math.random() * blossoms.length)];
                hp = 75;
            } else if (species === 'dead') {
                trunkColor = 0x3f2913;
                trunkHeight = 5 + Math.random() * 3;
                trunkRadiusBase = 0.6;
                trunkRadiusTop = 0.3;
                foliageColor = null; // no foliage
                hp = 60;
            }

            const trunkMat = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.95 });

            // Build trunk: birch gets dark patches; willow/oak gets a slight curve via stacked segments
            if (species === 'birch') {
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(trunkRadiusTop, trunkRadiusBase, trunkHeight, 10),
                    trunkMat
                );
                trunk.position.y = trunkHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                // Dark horizontal patches
                const patchMat = new THREE.MeshStandardMaterial({ color: 0x1c1917 });
                const patchCount = 4 + Math.floor(Math.random() * 4);
                for (let i = 0; i < patchCount; i++) {
                    const patch = new THREE.Mesh(
                        new THREE.BoxGeometry(trunkRadiusBase * 1.5, 0.15 + Math.random() * 0.2, 0.05),
                        patchMat
                    );
                    const yPos = (i + 1) * (trunkHeight / (patchCount + 1)) + (Math.random() - 0.5) * 0.4;
                    patch.position.set(0, yPos, 0);
                    patch.rotation.y = Math.random() * Math.PI * 2;
                    // Wrap roughly around trunk by placing at radius
                    const angle = Math.random() * Math.PI * 2;
                    patch.position.x = Math.cos(angle) * trunkRadiusBase * 0.95;
                    patch.position.z = Math.sin(angle) * trunkRadiusBase * 0.95;
                    patch.lookAt(0, yPos, 0);
                    group.add(patch);
                }
            } else if (species === 'oak' || species === 'willow') {
                // Slightly curved trunk: 2 stacked segments with a small angle
                const lower = new THREE.Mesh(
                    new THREE.CylinderGeometry(trunkRadiusBase * 0.85, trunkRadiusBase, trunkHeight * 0.55, 8),
                    trunkMat
                );
                lower.position.y = trunkHeight * 0.275;
                lower.castShadow = true;
                group.add(lower);
                const upper = new THREE.Mesh(
                    new THREE.CylinderGeometry(trunkRadiusTop, trunkRadiusBase * 0.85, trunkHeight * 0.5, 8),
                    trunkMat
                );
                upper.position.y = trunkHeight * 0.55 + (trunkHeight * 0.5) / 2;
                const tilt = (Math.random() - 0.5) * 0.15;
                upper.rotation.z = tilt;
                upper.position.x = Math.sin(tilt) * trunkHeight * 0.25;
                upper.castShadow = true;
                group.add(upper);
            } else {
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(trunkRadiusTop, trunkRadiusBase, trunkHeight, 8),
                    trunkMat
                );
                trunk.position.y = trunkHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
            }

            // === FOLIAGE ===
            if (species === 'pine') {
                // Stacked cones, decreasing in size going up
                const tiers = 3 + Math.floor(Math.random() * 2);
                for (let i = 0; i < tiers; i++) {
                    const tierRadius = 3.5 - i * 0.7;
                    const tierH = 3;
                    const cone = new THREE.Mesh(
                        new THREE.ConeGeometry(tierRadius, tierH, 8),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.05), roughness: 0.9 })
                    );
                    cone.position.y = trunkHeight - 1 + i * 2.2;
                    cone.castShadow = true;
                    group.add(cone);
                }
            } else if (species === 'oak') {
                // Several overlapping spheres for a chunky canopy
                const radius = 3.5 + Math.random() * 1;
                const blobs = 4 + Math.floor(Math.random() * 3);
                for (let i = 0; i < blobs; i++) {
                    const r = radius * (0.7 + Math.random() * 0.5);
                    const sphere = new THREE.Mesh(
                        new THREE.SphereGeometry(r, 8, 6),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.08), roughness: 0.9 })
                    );
                    const angle = (i / blobs) * Math.PI * 2 + Math.random() * 0.5;
                    const dist = (Math.random() * 1.2);
                    sphere.position.set(
                        Math.cos(angle) * dist,
                        trunkHeight + 1.5 + (Math.random() - 0.3) * 1,
                        Math.sin(angle) * dist
                    );
                    sphere.castShadow = true;
                    group.add(sphere);
                }
            } else if (species === 'birch') {
                // Tall narrow oval canopy, slightly transparent edges
                const oval = new THREE.Mesh(
                    new THREE.SphereGeometry(2.5, 10, 8),
                    new THREE.MeshStandardMaterial({ color: foliageColor, roughness: 0.9 })
                );
                oval.scale.set(1, 1.6, 1);
                oval.position.y = trunkHeight + 1.5;
                oval.castShadow = true;
                group.add(oval);
                // A few smaller secondary blobs for asymmetry
                for (let i = 0; i < 2; i++) {
                    const small = new THREE.Mesh(
                        new THREE.SphereGeometry(1.5, 6, 6),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.08), roughness: 0.9 })
                    );
                    small.position.set(
                        (Math.random() - 0.5) * 2.5,
                        trunkHeight + Math.random() * 3,
                        (Math.random() - 0.5) * 2.5
                    );
                    small.castShadow = true;
                    group.add(small);
                }
            } else if (species === 'maple') {
                // Wide rounded canopy with multiple blobs
                const radius = 3.8 + Math.random() * 0.8;
                const blobs = 5 + Math.floor(Math.random() * 3);
                for (let i = 0; i < blobs; i++) {
                    const r = radius * (0.55 + Math.random() * 0.5);
                    const sphere = new THREE.Mesh(
                        new THREE.SphereGeometry(r, 8, 6),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.08), roughness: 0.9 })
                    );
                    const angle = (i / blobs) * Math.PI * 2 + Math.random() * 0.6;
                    const dist = Math.random() * 1.8;
                    sphere.position.set(
                        Math.cos(angle) * dist,
                        trunkHeight + 1 + (Math.random() - 0.3) * 1.4,
                        Math.sin(angle) * dist
                    );
                    sphere.castShadow = true;
                    group.add(sphere);
                }
            } else if (species === 'willow') {
                // Drooping layered foliage — flatter, wider domes
                for (let layer = 0; layer < 3; layer++) {
                    const dome = new THREE.Mesh(
                        new THREE.SphereGeometry(3 + layer * 0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.07), roughness: 0.95 })
                    );
                    dome.scale.set(1.2, 0.7, 1.2);
                    dome.position.y = trunkHeight + 0.5 - layer * 0.8;
                    dome.castShadow = true;
                    group.add(dome);
                }
                // Drooping strands (thin cylinders hanging down)
                for (let s = 0; s < 8; s++) {
                    const strand = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.06, 0.04, 2 + Math.random() * 1.5, 4),
                        new THREE.MeshStandardMaterial({ color: jitterColor(foliageColor, 0.08) })
                    );
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 2.5 + Math.random() * 1;
                    strand.position.set(
                        Math.cos(angle) * dist,
                        trunkHeight + 0.5 - 1,
                        Math.sin(angle) * dist
                    );
                    group.add(strand);
                }
            } else if (species === 'cypress') {
                // Tall narrow elongated cone
                const cone = new THREE.Mesh(
                    new THREE.ConeGeometry(1.5, trunkHeight * 0.85, 10),
                    new THREE.MeshStandardMaterial({ color: foliageColor, roughness: 0.9 })
                );
                cone.position.y = trunkHeight * 0.5 + (trunkHeight * 0.85) / 2 - 1;
                cone.castShadow = true;
                group.add(cone);
            } else if (species === 'cherry') {
                // Soft, fluffy pink/white canopy: many small spheres
                const radius = 3 + Math.random() * 0.6;
                const blobs = 7 + Math.floor(Math.random() * 4);
                for (let i = 0; i < blobs; i++) {
                    const r = radius * (0.5 + Math.random() * 0.4);
                    const sphere = new THREE.Mesh(
                        new THREE.SphereGeometry(r, 8, 6),
                        new THREE.MeshStandardMaterial({
                            color: jitterColor(foliageColor, 0.05),
                            roughness: 0.95,
                            emissive: foliageColor,
                            emissiveIntensity: 0.05
                        })
                    );
                    const angle = (i / blobs) * Math.PI * 2 + Math.random() * 0.7;
                    const dist = Math.random() * 2;
                    sphere.position.set(
                        Math.cos(angle) * dist,
                        trunkHeight + 0.8 + (Math.random() - 0.3) * 1.3,
                        Math.sin(angle) * dist
                    );
                    sphere.castShadow = true;
                    group.add(sphere);
                }
            } else if (species === 'dead') {
                // Bare gnarled branches sticking out from trunk top
                const branchMat = new THREE.MeshStandardMaterial({ color: trunkColor, roughness: 0.95 });
                const branchCount = 4 + Math.floor(Math.random() * 4);
                for (let b = 0; b < branchCount; b++) {
                    const branchLen = 1.5 + Math.random() * 1.5;
                    const branch = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.08, 0.18, branchLen, 5),
                        branchMat
                    );
                    const angle = (b / branchCount) * Math.PI * 2 + Math.random() * 0.5;
                    const yPos = trunkHeight - 1 + Math.random() * 1.5;
                    branch.position.set(
                        Math.cos(angle) * 0.5,
                        yPos,
                        Math.sin(angle) * 0.5
                    );
                    // Tilt outward and slightly up
                    branch.rotation.z = Math.cos(angle) * (Math.PI / 3 + Math.random() * 0.4);
                    branch.rotation.x = -Math.sin(angle) * (Math.PI / 3 + Math.random() * 0.4);
                    branch.position.x += Math.cos(angle) * branchLen * 0.4;
                    branch.position.z += Math.sin(angle) * branchLen * 0.4;
                    branch.position.y += branchLen * 0.2;
                    branch.castShadow = true;
                    group.add(branch);
                    // Sub-twig
                    if (Math.random() < 0.6) {
                        const twig = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.04, 0.08, 0.8, 4),
                            branchMat
                        );
                        twig.position.copy(branch.position);
                        twig.position.x += Math.cos(angle) * 0.6;
                        twig.position.z += Math.sin(angle) * 0.6;
                        twig.position.y += 0.4;
                        twig.rotation.z = Math.cos(angle) * Math.PI * 0.4;
                        twig.rotation.x = -Math.sin(angle) * Math.PI * 0.4;
                        group.add(twig);
                    }
                }
            }

            // Random Y rotation so trees don't all face the same way
            group.rotation.y = Math.random() * Math.PI * 2;

            group.userData.hp = hp;
            group.userData.maxHp = hp;
            group.userData.species = species;
            group.userData.trunkHeight = trunkHeight;
        }

        // ===== PROCEDURAL MOUNTAIN BUILDER =====
        // ===== PROCEDURAL ANIMAL BUILDER =====
        const ANIMAL_SPECIES = ['deer', 'wolf', 'bear', 'rabbit', 'cow', 'fox'];

        function buildAnimal(group, forcedSpecies) {
            const species = forcedSpecies || ANIMAL_SPECIES[Math.floor(Math.random() * ANIMAL_SPECIES.length)];
            let bodyColor, accentColor, hp, speed, scale;

            if (species === 'deer') {
                bodyColor = 0xa0794a; accentColor = 0xfff8e8;
                hp = 30; speed = 0.18; scale = 1;
            } else if (species === 'wolf') {
                bodyColor = 0x6b6f76; accentColor = 0x2a2c30;
                hp = 50; speed = 0.22; scale = 0.9;
            } else if (species === 'bear') {
                bodyColor = 0x4a2c1e; accentColor = 0x2a1810;
                hp = 100; speed = 0.14; scale = 1.4;
            } else if (species === 'rabbit') {
                bodyColor = 0xd4cfc4; accentColor = 0xfafaf5;
                hp = 12; speed = 0.32; scale = 0.5;
            } else if (species === 'cow') {
                bodyColor = 0xfafaf5; accentColor = 0x1a1a1a;
                hp = 60; speed = 0.1; scale = 1.1;
            } else if (species === 'fox') {
                bodyColor = 0xc05828; accentColor = 0xfafaf5;
                hp = 22; speed = 0.26; scale = 0.7;
            }

            const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.9 });
            const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.95 });

            // Body — quadruped torso (box)
            const body = new THREE.Mesh(
                new THREE.BoxGeometry(2.5 * scale, 1.2 * scale, 1.0 * scale),
                bodyMat
            );
            body.position.set(0, 1.2 * scale, 0);
            body.castShadow = true;
            group.add(body);

            // Head — sphere or box at one end
            let headGeo;
            if (species === 'deer' || species === 'fox') {
                headGeo = new THREE.BoxGeometry(0.8 * scale, 0.7 * scale, 0.6 * scale);
            } else if (species === 'wolf') {
                headGeo = new THREE.BoxGeometry(0.7 * scale, 0.6 * scale, 0.55 * scale);
            } else if (species === 'bear') {
                headGeo = new THREE.SphereGeometry(0.7 * scale, 8, 6);
            } else if (species === 'rabbit') {
                headGeo = new THREE.SphereGeometry(0.5 * scale, 8, 6);
            } else if (species === 'cow') {
                headGeo = new THREE.BoxGeometry(0.9 * scale, 0.7 * scale, 0.7 * scale);
            }
            const head = new THREE.Mesh(headGeo, bodyMat);
            head.position.set(1.4 * scale, 1.5 * scale, 0);
            head.castShadow = true;
            group.add(head);

            // Snout/muzzle
            if (species === 'wolf' || species === 'fox' || species === 'deer') {
                const snout = new THREE.Mesh(
                    new THREE.BoxGeometry(0.4 * scale, 0.3 * scale, 0.3 * scale),
                    species === 'wolf' ? accentMat : bodyMat
                );
                snout.position.set(2.0 * scale, 1.4 * scale, 0);
                group.add(snout);
            }

            // Eyes (two small black dots)
            const eyeMat = new THREE.MeshStandardMaterial({ color: 0x000000 });
            for (const ez of [-0.18, 0.18]) {
                const eye = new THREE.Mesh(new THREE.SphereGeometry(0.08 * scale, 6, 5), eyeMat);
                eye.position.set(1.7 * scale, 1.65 * scale, ez * scale);
                group.add(eye);
            }

            // Ears
            if (species === 'rabbit') {
                // Long ears
                for (const ez of [-0.2, 0.2]) {
                    const ear = new THREE.Mesh(
                        new THREE.BoxGeometry(0.15 * scale, 0.7 * scale, 0.15 * scale),
                        bodyMat
                    );
                    ear.position.set(1.4 * scale, 2.1 * scale, ez * scale);
                    group.add(ear);
                }
            } else if (species === 'wolf' || species === 'fox') {
                // Pointy ears
                for (const ez of [-0.25, 0.25]) {
                    const ear = new THREE.Mesh(
                        new THREE.ConeGeometry(0.15 * scale, 0.35 * scale, 4),
                        bodyMat
                    );
                    ear.position.set(1.3 * scale, 1.95 * scale, ez * scale);
                    group.add(ear);
                }
            } else if (species === 'bear') {
                // Round ears
                for (const ez of [-0.35, 0.35]) {
                    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.2 * scale, 6, 5), bodyMat);
                    ear.position.set(1.2 * scale, 1.95 * scale, ez * scale);
                    group.add(ear);
                }
            } else if (species === 'cow') {
                // Cow ears (sideways nubs) and horns
                for (const ez of [-0.4, 0.4]) {
                    const ear = new THREE.Mesh(
                        new THREE.BoxGeometry(0.15 * scale, 0.2 * scale, 0.3 * scale),
                        bodyMat
                    );
                    ear.position.set(1.3 * scale, 1.75 * scale, ez * scale);
                    group.add(ear);
                }
                // Horns
                for (const ez of [-0.25, 0.25]) {
                    const horn = new THREE.Mesh(
                        new THREE.ConeGeometry(0.08 * scale, 0.4 * scale, 5),
                        new THREE.MeshStandardMaterial({ color: 0xeed8a0 })
                    );
                    horn.position.set(1.3 * scale, 1.95 * scale, ez * scale);
                    horn.rotation.z = ez < 0 ? -0.4 : 0.4;
                    group.add(horn);
                }
            }

            // Antlers for deer
            if (species === 'deer') {
                const antlerMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a });
                for (const ez of [-0.18, 0.18]) {
                    const antler = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.04 * scale, 0.06 * scale, 0.7 * scale, 5),
                        antlerMat
                    );
                    antler.position.set(1.3 * scale, 2.0 * scale, ez * scale);
                    antler.rotation.z = ez < 0 ? -0.3 : 0.3;
                    antler.rotation.x = -0.3;
                    group.add(antler);
                    // Branches
                    for (let b = 0; b < 2; b++) {
                        const branch = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.03 * scale, 0.04 * scale, 0.3 * scale, 4),
                            antlerMat
                        );
                        branch.position.set(1.3 * scale + b * 0.05 * scale, 2.2 * scale + b * 0.1 * scale, ez * scale + (b - 0.5) * 0.1 * scale);
                        branch.rotation.z = ez < 0 ? -0.6 : 0.6;
                        group.add(branch);
                    }
                }
            }

            // Cow spots
            if (species === 'cow') {
                for (let s = 0; s < 6; s++) {
                    const spot = new THREE.Mesh(
                        new THREE.SphereGeometry((0.25 + Math.random() * 0.2) * scale, 8, 5),
                        accentMat
                    );
                    const ax = (Math.random() - 0.5) * 2.4 * scale;
                    const ay = (Math.random() - 0.4) * 0.8 * scale + 1.2 * scale;
                    const az = (Math.random() < 0.5 ? -1 : 1) * 0.5 * scale;
                    spot.position.set(ax, ay, az);
                    spot.scale.set(1, 0.5, 0.4);
                    group.add(spot);
                }
            }

            // Tail
            let tailGeo, tailColor = bodyColor;
            if (species === 'deer' || species === 'rabbit') {
                tailGeo = new THREE.SphereGeometry(0.2 * scale, 6, 5);
                tailColor = accentColor;
            } else if (species === 'fox') {
                tailGeo = new THREE.CylinderGeometry(0.2 * scale, 0.1 * scale, 1.0 * scale, 6);
            } else if (species === 'wolf') {
                tailGeo = new THREE.CylinderGeometry(0.15 * scale, 0.08 * scale, 0.8 * scale, 6);
            } else if (species === 'bear') {
                tailGeo = new THREE.SphereGeometry(0.18 * scale, 6, 5);
            } else if (species === 'cow') {
                tailGeo = new THREE.CylinderGeometry(0.05 * scale, 0.05 * scale, 1.0 * scale, 4);
            }
            const tail = new THREE.Mesh(tailGeo, new THREE.MeshStandardMaterial({ color: tailColor, roughness: 0.95 }));
            if (species === 'fox' || species === 'wolf') {
                tail.position.set(-1.4 * scale, 1.4 * scale, 0);
                tail.rotation.z = Math.PI / 2;
            } else if (species === 'cow') {
                tail.position.set(-1.4 * scale, 1.0 * scale, 0);
            } else {
                tail.position.set(-1.4 * scale, 1.3 * scale, 0);
            }
            group.add(tail);

            // Four legs
            const legGeo = new THREE.CylinderGeometry(0.13 * scale, 0.15 * scale, 1.2 * scale, 6);
            const legMat = species === 'cow' ? bodyMat : (species === 'wolf' ? accentMat : bodyMat);
            const legPositions = [
                [-1.0, 0.6, -0.4], [1.0, 0.6, -0.4],
                [-1.0, 0.6, 0.4], [1.0, 0.6, 0.4]
            ];
            const legs = [];
            legPositions.forEach(p => {
                const leg = new THREE.Mesh(legGeo, legMat);
                leg.position.set(p[0] * scale, p[1] * scale, p[2] * scale);
                leg.castShadow = true;
                group.add(leg);
                legs.push(leg);
            });

            group.userData.type = 'animal';
            group.userData.species = species;
            group.userData.bodyColor = bodyColor;
            group.userData.hp = hp;
            group.userData.maxHp = hp;
            group.userData.speed = speed;
            group.userData.legs = legs;
            group.userData.walkPhase = Math.random() * Math.PI * 2;
            group.userData.wanderTarget = null;
            group.userData.wanderTimer = 0;
            group.userData.idleTimer = 0;
            group.userData.scaleVal = scale;
        }

        function buildMountain(group) {
            // === SIZE: wide range ===
            const baseRadius = 14 + Math.random() * 28;
            const peakHeight = 18 + Math.random() * 50;
            // Asymmetry: stretch one direction so mountains aren't perfectly round
            const stretchX = 0.7 + Math.random() * 0.7;
            const stretchZ = 0.7 + Math.random() * 0.7;
            // Slight lean angle (mountains can tilt up to 8 degrees)
            const leanX = (Math.random() - 0.5) * 0.15;
            const leanZ = (Math.random() - 0.5) * 0.15;

            // === COLOR: many palettes, jittered per mountain ===
            const palettes = [
                { rock: 0x6b6557, dark: 0x3f3a30, snow: 0xf0f4f8, name: 'slate' },
                { rock: 0x57534e, dark: 0x292524, snow: 0xf5f7f9, name: 'charcoal' },
                { rock: 0x78635a, dark: 0x44352d, snow: 0xece8e1, name: 'umber' },
                { rock: 0x5a5d6e, dark: 0x2e3140, snow: 0xfafdff, name: 'bluestone' },
                { rock: 0x8a7560, dark: 0x4a3e30, snow: 0xfff5e0, name: 'sandstone' },
                { rock: 0x4d5944, dark: 0x252e22, snow: 0xeef2e8, name: 'mossrock' },
                { rock: 0x3a3a3a, dark: 0x1a1a1a, snow: 0xfafafa, name: 'volcanic' },
            ];
            const pal = palettes[Math.floor(Math.random() * palettes.length)];
            // Jitter the palette slightly for uniqueness
            function jitter(hex, amt) {
                const c = new THREE.Color(hex);
                c.r = Math.max(0, Math.min(1, c.r + (Math.random() - 0.5) * amt));
                c.g = Math.max(0, Math.min(1, c.g + (Math.random() - 0.5) * amt));
                c.b = Math.max(0, Math.min(1, c.b + (Math.random() - 0.5) * amt));
                return c.getHex();
            }
            const rockMat = new THREE.MeshStandardMaterial({
                color: jitter(pal.rock, 0.08),
                roughness: 0.92 + Math.random() * 0.06,
                flatShading: true
            });
            const darkMat = new THREE.MeshStandardMaterial({
                color: jitter(pal.dark, 0.08),
                roughness: 1,
                flatShading: true
            });
            const snowMat = new THREE.MeshStandardMaterial({
                color: pal.snow,
                roughness: 0.85
            });

            // === SHAPE TYPE: pick one of several styles ===
            const shapeRoll = Math.random();
            let shapeType;
            if (shapeRoll < 0.35) shapeType = 'single';     // single peak
            else if (shapeRoll < 0.6) shapeType = 'twin';   // two peaks side by side
            else if (shapeRoll < 0.8) shapeType = 'rugged'; // multiple smaller peaks clustered
            else shapeType = 'plateau';                      // flat-topped mesa

            const segments = 16 + Math.floor(Math.random() * 8); // 16-23
            const heightSegs = 6 + Math.floor(Math.random() * 5); // 6-10

            function distortConeGeo(geo, h, displaceFactor) {
                const p = geo.attributes.position;
                for (let i = 0; i < p.count; i++) {
                    const x = p.getX(i);
                    const y = p.getY(i);
                    // Don't displace the very tip or the base
                    const tipFactor = Math.max(0, 1 - Math.abs(y - h / 2) / (h * 0.45));
                    const noise = (Math.random() - 0.5) * 4 * displaceFactor * (1 - tipFactor * 0.7);
                    p.setX(i, x + noise);
                    p.setZ(i, p.getZ(i) + noise * 0.7);
                    if (Math.abs(y) < h / 2 - 1) {
                        p.setY(i, y + (Math.random() - 0.5) * 2 * displaceFactor);
                    }
                }
                geo.computeVertexNormals();
            }

            if (shapeType === 'single') {
                const coneGeo = new THREE.ConeGeometry(baseRadius, peakHeight, segments, heightSegs);
                distortConeGeo(coneGeo, peakHeight, 1);
                const peak = new THREE.Mesh(coneGeo, rockMat);
                peak.scale.set(stretchX, 1, stretchZ);
                peak.position.y = peakHeight / 2;
                peak.castShadow = true;
                peak.receiveShadow = true;
                group.add(peak);
            } else if (shapeType === 'twin') {
                const offset = baseRadius * 0.45;
                const peakAngle = Math.random() * Math.PI;
                const ox = Math.cos(peakAngle) * offset;
                const oz = Math.sin(peakAngle) * offset;
                // Peak A
                const hA = peakHeight * (0.85 + Math.random() * 0.15);
                const rA = baseRadius * 0.7;
                const gA = new THREE.ConeGeometry(rA, hA, segments, heightSegs);
                distortConeGeo(gA, hA, 1);
                const pA = new THREE.Mesh(gA, rockMat);
                pA.position.set(ox, hA / 2, oz);
                pA.castShadow = true;
                pA.receiveShadow = true;
                group.add(pA);
                // Peak B
                const hB = peakHeight * (0.7 + Math.random() * 0.2);
                const rB = baseRadius * 0.65;
                const gB = new THREE.ConeGeometry(rB, hB, segments, heightSegs);
                distortConeGeo(gB, hB, 1);
                const pB = new THREE.Mesh(gB, rockMat);
                pB.position.set(-ox, hB / 2, -oz);
                pB.castShadow = true;
                pB.receiveShadow = true;
                group.add(pB);
            } else if (shapeType === 'rugged') {
                // 3-5 smaller peaks clustered together
                const peakCount = 3 + Math.floor(Math.random() * 3);
                for (let i = 0; i < peakCount; i++) {
                    const ang = (i / peakCount) * Math.PI * 2 + Math.random() * 0.5;
                    const dist = baseRadius * 0.3 * Math.random();
                    const h = peakHeight * (0.5 + Math.random() * 0.5);
                    const r = baseRadius * (0.4 + Math.random() * 0.4);
                    const g = new THREE.ConeGeometry(r, h, segments - 2, heightSegs);
                    distortConeGeo(g, h, 1.2);
                    const p = new THREE.Mesh(g, rockMat);
                    p.position.set(Math.cos(ang) * dist, h / 2, Math.sin(ang) * dist);
                    p.rotation.y = Math.random() * Math.PI;
                    p.castShadow = true;
                    p.receiveShadow = true;
                    group.add(p);
                }
            } else if (shapeType === 'plateau') {
                // Flat-topped mesa: cylinder with distorted sides
                const topRadius = baseRadius * (0.5 + Math.random() * 0.25);
                const cylH = peakHeight * 0.85;
                const cylGeo = new THREE.CylinderGeometry(topRadius, baseRadius, cylH, segments, heightSegs);
                const cP = cylGeo.attributes.position;
                for (let i = 0; i < cP.count; i++) {
                    const y = cP.getY(i);
                    if (Math.abs(y - cylH / 2) > 0.5 && Math.abs(y + cylH / 2) > 0.5) {
                        cP.setX(i, cP.getX(i) + (Math.random() - 0.5) * 3);
                        cP.setZ(i, cP.getZ(i) + (Math.random() - 0.5) * 3);
                    }
                }
                cylGeo.computeVertexNormals();
                const mesa = new THREE.Mesh(cylGeo, rockMat);
                mesa.scale.set(stretchX, 1, stretchZ);
                mesa.position.y = cylH / 2;
                mesa.castShadow = true;
                mesa.receiveShadow = true;
                group.add(mesa);
                // Maybe a small bump on top
                if (Math.random() < 0.5) {
                    const bumpGeo = new THREE.ConeGeometry(topRadius * 0.4, peakHeight * 0.2, 10, 3);
                    distortConeGeo(bumpGeo, peakHeight * 0.2, 0.6);
                    const bump = new THREE.Mesh(bumpGeo, rockMat);
                    bump.position.set((Math.random() - 0.5) * topRadius * 0.5, cylH + peakHeight * 0.1, (Math.random() - 0.5) * topRadius * 0.5);
                    bump.castShadow = true;
                    group.add(bump);
                }
            }

            // === FOOTHILLS: variable count and shape ===
            const foothillCount = 3 + Math.floor(Math.random() * 6);
            for (let i = 0; i < foothillCount; i++) {
                const angle = (i / foothillCount) * Math.PI * 2 + Math.random() * 0.7;
                const dist = baseRadius * (0.65 + Math.random() * 0.3);
                const fhRadius = 4 + Math.random() * 8;
                const fhGeo = new THREE.SphereGeometry(fhRadius, 8 + Math.floor(Math.random() * 4), 6 + Math.floor(Math.random() * 3));
                const fhPos = fhGeo.attributes.position;
                for (let j = 0; j < fhPos.count; j++) {
                    fhPos.setXYZ(j,
                        fhPos.getX(j) + (Math.random() - 0.5) * 2,
                        fhPos.getY(j) + (Math.random() - 0.5) * 2,
                        fhPos.getZ(j) + (Math.random() - 0.5) * 2
                    );
                }
                fhGeo.computeVertexNormals();
                const fh = new THREE.Mesh(fhGeo, Math.random() < 0.6 ? darkMat : rockMat);
                fh.position.set(
                    Math.cos(angle) * dist * stretchX,
                    fhRadius * (0.3 + Math.random() * 0.3),
                    Math.sin(angle) * dist * stretchZ
                );
                fh.scale.y = 0.4 + Math.random() * 0.5;
                fh.rotation.y = Math.random() * Math.PI * 2;
                fh.castShadow = true;
                fh.receiveShadow = true;
                group.add(fh);
            }

            // === SNOW CAP on tall mountains ===
            if (peakHeight > 35 && shapeType !== 'plateau') {
                const snowCount = shapeType === 'twin' ? 2 : (shapeType === 'rugged' ? 2 : 1);
                for (let s = 0; s < snowCount; s++) {
                    const capRadius = baseRadius * (0.25 + Math.random() * 0.18);
                    const capH = peakHeight * (0.12 + Math.random() * 0.12);
                    const capGeo = new THREE.ConeGeometry(capRadius, capH, 12, 3);
                    const capPos = capGeo.attributes.position;
                    for (let i = 0; i < capPos.count; i++) {
                        const ny = capPos.getY(i);
                        if (Math.abs(ny - capH / 2) > 0.5) {
                            capPos.setX(i, capPos.getX(i) + (Math.random() - 0.5) * 1.2);
                            capPos.setZ(i, capPos.getZ(i) + (Math.random() - 0.5) * 1.2);
                        }
                    }
                    capGeo.computeVertexNormals();
                    const cap = new THREE.Mesh(capGeo, snowMat);
                    if (shapeType === 'twin') {
                        cap.position.set(
                            (s === 0 ? 1 : -1) * baseRadius * 0.45 * Math.cos(Math.PI * 0.3),
                            peakHeight * 0.92 - capH * 0.3,
                            (s === 0 ? 1 : -1) * baseRadius * 0.45 * Math.sin(Math.PI * 0.3)
                        );
                    } else {
                        cap.position.set((Math.random() - 0.5) * 2, peakHeight - capH * 0.3, (Math.random() - 0.5) * 2);
                    }
                    cap.castShadow = true;
                    group.add(cap);
                }
            }

            // === BOULDERS at base, variable count and size ===
            const boulderCount = 3 + Math.floor(Math.random() * 8);
            for (let i = 0; i < boulderCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = baseRadius + 1 + Math.random() * 7;
                const bSize = 0.6 + Math.random() * 2.8;
                const bGeo = new THREE.SphereGeometry(bSize, 6, 5);
                const bPos = bGeo.attributes.position;
                for (let j = 0; j < bPos.count; j++) {
                    bPos.setXYZ(j,
                        bPos.getX(j) + (Math.random() - 0.5) * 0.6,
                        bPos.getY(j) + (Math.random() - 0.5) * 0.6,
                        bPos.getZ(j) + (Math.random() - 0.5) * 0.6
                    );
                }
                bGeo.computeVertexNormals();
                const boulder = new THREE.Mesh(bGeo, Math.random() < 0.5 ? rockMat : darkMat);
                boulder.position.set(Math.cos(angle) * dist, bSize * (0.2 + Math.random() * 0.4), Math.sin(angle) * dist);
                boulder.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
                boulder.scale.set(1, 0.6 + Math.random() * 0.6, 1);
                boulder.castShadow = true;
                group.add(boulder);
            }

            // === RANDOM TREES ON THE SLOPES (sometimes) ===
            if (Math.random() < 0.4 && shapeType !== 'plateau') {
                const treesOnSlope = 2 + Math.floor(Math.random() * 4);
                for (let t = 0; t < treesOnSlope; t++) {
                    const ang = Math.random() * Math.PI * 2;
                    const slopeDist = baseRadius * (0.4 + Math.random() * 0.4);
                    const slopeY = peakHeight * (0.2 + Math.random() * 0.3);
                    const sapling = new THREE.Mesh(
                        new THREE.ConeGeometry(1.2 + Math.random(), 3 + Math.random() * 2, 6),
                        new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.9 })
                    );
                    sapling.position.set(Math.cos(ang) * slopeDist, slopeY, Math.sin(ang) * slopeDist);
                    sapling.castShadow = true;
                    group.add(sapling);
                }
            }

            group.rotation.y = Math.random() * Math.PI * 2;
            group.rotation.x = leanX;
            group.rotation.z = leanZ;

            group.userData.isStatic = true;
            group.userData.hp = 600 + Math.random() * 800; // can be smashed down by determined cyclops or weapons
            group.userData.maxHp = group.userData.hp;
            group.userData.footprint = baseRadius * 2 * Math.max(stretchX, stretchZ);
            group.userData.shapeType = shapeType;
            group.userData.palette = pal.name;
        }

        function placeObject(type, pt) {
            const group = new THREE.Group();
            group.userData = {
                type,
                velocity: new THREE.Vector3(),
                hp: 100,
                maxHp: 100,
                onFire: false,
                burnLevel: 0,         // 0..1, charring progression
                isStatic: false,
                isFalling: false,
                fallAxis: null,
                fallAngle: 0,
                spreadTimer: 0,
                lifeTime: 0
            };

            if (type === 'house') {
                buildHouse(group);
            } else if (type === 'skyscraper') {
                buildSkyscraper(group);
            } else if (type === 'tree') {
                buildTree(group);
            } else if (type === 'mountain') {
                buildMountain(group);
            } else if (type === 'animal') {
                buildAnimal(group);
            } else if (type === 'human') {
                const mat = new THREE.MeshStandardMaterial({ color: 0x3b82f6 });
                const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2), mat);
                body.position.y = 1; body.castShadow = true; group.add(body);
                const head = new THREE.Mesh(new THREE.SphereGeometry(0.5), mat);
                head.position.y = 1.8; head.castShadow = true; group.add(head);
                group.userData.hp = 40;
                group.userData.maxHp = 40;
                group.userData.speed = 0.18 + Math.random() * 0.08;
                group.userData.dir = Math.random() * Math.PI * 2;
                // Find nearest house as a "home" so they don't wander far
                group.userData.home = findNearestHouse(pt);
                group.userData.wanderTarget = pickNearbyTarget(pt, group.userData.home);
                group.userData.walkPhase = Math.random() * Math.PI * 2;
            } else if (type === 'builder') {
                // Builders: orange/brown work clothes, hard hat
                const bodyMat = new THREE.MeshStandardMaterial({ color: 0xea580c });
                const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2), bodyMat);
                body.position.y = 1; body.castShadow = true; group.add(body);
                const skinMat = new THREE.MeshStandardMaterial({ color: 0xfbbf24 });
                const head = new THREE.Mesh(new THREE.SphereGeometry(0.5), skinMat);
                head.position.y = 1.8; head.castShadow = true; group.add(head);
                // Hard hat
                const hatMat = new THREE.MeshStandardMaterial({ color: 0xfacc15 });
                const hat = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), hatMat);
                hat.position.y = 2.05;
                hat.castShadow = true;
                group.add(hat);
                // Hat brim
                const brim = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.65, 0.65, 0.08, 12),
                    hatMat
                );
                brim.position.y = 1.99;
                group.add(brim);
                group.userData.type = 'builder';
                group.userData.hp = 50;
                group.userData.maxHp = 50;
                group.userData.speed = 0.2;
                group.userData.walkPhase = Math.random() * Math.PI * 2;
                // Builder AI state
                group.userData.task = 'idle';     // idle, goToTree, chopping, goToBuild, building
                group.userData.taskTimer = 0;
                group.userData.targetTree = null;
                group.userData.lumber = 2; // start with some wood so they build faster
                group.userData.buildSite = null;
                group.userData.buildProgress = 0;
            } else if (type === 'invader') {
                // 50/50 mounted vs on-foot
                const mounted = Math.random() < 0.5;
                const armorMat = new THREE.MeshStandardMaterial({ color: 0x44403c, roughness: 0.8, metalness: 0.4 });
                const cloakMat = new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.95 });
                const skinMat = new THREE.MeshStandardMaterial({ color: 0xc69477 });
                const crossbowMat = new THREE.MeshStandardMaterial({ color: 0x44352b, roughness: 1 });
                const stringMat = new THREE.MeshStandardMaterial({ color: 0xd4a574 });

                if (mounted) {
                    // Horse
                    const horseMat = new THREE.MeshStandardMaterial({ color: 0x57342a, roughness: 0.9 });
                    const horseDarkMat = new THREE.MeshStandardMaterial({ color: 0x2a1810, roughness: 0.95 });
                    // Body
                    const horseBody = new THREE.Mesh(
                        new THREE.BoxGeometry(1.6, 1.4, 3.2),
                        horseMat
                    );
                    horseBody.position.set(0, 2.0, 0);
                    horseBody.castShadow = true;
                    group.add(horseBody);
                    // Neck
                    const horseNeck = new THREE.Mesh(
                        new THREE.BoxGeometry(0.9, 1.4, 0.9),
                        horseMat
                    );
                    horseNeck.position.set(0, 2.7, 1.4);
                    horseNeck.rotation.x = -0.4;
                    horseNeck.castShadow = true;
                    group.add(horseNeck);
                    // Head
                    const horseHead = new THREE.Mesh(
                        new THREE.BoxGeometry(0.7, 0.7, 1.4),
                        horseMat
                    );
                    horseHead.position.set(0, 3.1, 2.3);
                    horseHead.castShadow = true;
                    group.add(horseHead);
                    // Mane (tuft of dark fur on neck)
                    for (let i = 0; i < 4; i++) {
                        const mane = new THREE.Mesh(new THREE.SphereGeometry(0.25, 5, 4), horseDarkMat);
                        mane.position.set(0, 3.0 + i * 0.1, 1.0 + i * 0.1);
                        group.add(mane);
                    }
                    // Tail
                    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.05, 1.2, 5), horseDarkMat);
                    tail.position.set(0, 1.6, -1.7);
                    tail.rotation.x = -0.6;
                    group.add(tail);
                    // 4 legs
                    const legGeoH = new THREE.CylinderGeometry(0.2, 0.18, 2.0, 6);
                    const legPositions = [[-0.55, 1, 1.0], [0.55, 1, 1.0], [-0.55, 1, -1.0], [0.55, 1, -1.0]];
                    const horseLegs = [];
                    legPositions.forEach(p => {
                        const leg = new THREE.Mesh(legGeoH, horseDarkMat);
                        leg.position.set(p[0], p[1], p[2]);
                        leg.castShadow = true;
                        group.add(leg);
                        horseLegs.push(leg);
                    });
                    group.userData.horseLegs = horseLegs;

                    // Rider — sits atop the horse
                    const riderTorso = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 1.2, 8), armorMat);
                    riderTorso.position.set(0, 3.5, 0);
                    riderTorso.castShadow = true;
                    group.add(riderTorso);
                    const riderCloak = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 8, 1, true), cloakMat);
                    riderCloak.position.set(0, 3.4, -0.3);
                    riderCloak.castShadow = true;
                    group.add(riderCloak);
                    const riderHead = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), skinMat);
                    riderHead.position.set(0, 4.5, 0);
                    riderHead.castShadow = true;
                    group.add(riderHead);
                    // Helmet
                    const helmet = new THREE.Mesh(
                        new THREE.SphereGeometry(0.45, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
                        armorMat
                    );
                    helmet.position.set(0, 4.6, 0);
                    helmet.castShadow = true;
                    group.add(helmet);

                    // Crossbow held by rider — across body, pointing forward
                    const crossbow = new THREE.Group();
                    const stock = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.18, 0.18), crossbowMat);
                    crossbow.add(stock);
                    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 1.4), crossbowMat);
                    bow.position.x = 0.4;
                    crossbow.add(bow);
                    const string = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.4), stringMat);
                    string.position.set(0.55, 0, 0);
                    crossbow.add(string);
                    crossbow.position.set(0.5, 3.4, 0.3);
                    group.add(crossbow);
                    group.userData.crossbow = crossbow;

                    group.userData.speed = 0.32; // fast, mounted
                    group.userData.mounted = true;
                } else {
                    // On-foot infantry
                    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 1.3, 8), armorMat);
                    torso.position.y = 1.1;
                    torso.castShadow = true;
                    group.add(torso);
                    // Cloak draping
                    const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.75, 1.6, 8, 1, true), cloakMat);
                    cloak.position.set(0, 1.0, -0.3);
                    cloak.castShadow = true;
                    group.add(cloak);
                    const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), skinMat);
                    head.position.y = 2.0;
                    head.castShadow = true;
                    group.add(head);
                    // Helmet
                    const helmet = new THREE.Mesh(
                        new THREE.SphereGeometry(0.48, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
                        armorMat
                    );
                    helmet.position.y = 2.1;
                    helmet.castShadow = true;
                    group.add(helmet);
                    // Helmet point spike
                    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.4, 5), armorMat);
                    spike.position.y = 2.55;
                    group.add(spike);

                    // Crossbow held in front
                    const crossbow = new THREE.Group();
                    const stock = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.15, 0.15), crossbowMat);
                    crossbow.add(stock);
                    const bow = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 1.2), crossbowMat);
                    bow.position.x = 0.3;
                    crossbow.add(bow);
                    const string = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1.2), stringMat);
                    string.position.set(0.45, 0, 0);
                    crossbow.add(string);
                    crossbow.position.set(0.4, 1.3, 0.3);
                    group.add(crossbow);
                    group.userData.crossbow = crossbow;

                    group.userData.speed = 0.16; // slower on foot
                    group.userData.mounted = false;
                }

                group.userData.type = 'invader';
                group.userData.hp = mounted ? 60 : 35;
                group.userData.maxHp = group.userData.hp;
                group.userData.task = 'charge';
                group.userData.taskTimer = 0;
                group.userData.walkPhase = Math.random() * Math.PI * 2;
                group.userData.target = null;       // current target house
                group.userData.shootCooldown = 0;
            } else if (type === 'road') {
                const r = new THREE.Mesh(new THREE.BoxGeometry(12, 0.2, 12), new THREE.MeshStandardMaterial({ color: 0x334155 }));
                r.position.y = 0.1; r.receiveShadow = true; group.add(r);
                group.userData.isStatic = true;
                group.userData.hp = 10000;
                group.userData.maxHp = 10000;
            }

            group.position.set(pt.x, 0, pt.z);

            // Houses face the camera so their door is toward the player.
            // (The house is built with the door on the +Z face and rotation.y=0 facing +Z.)
            if (type === 'house') {
                const dx = camera.position.x - pt.x;
                const dz = camera.position.z - pt.z;
                group.rotation.y = Math.atan2(dx, dz);
            }

            storeOriginalColors(group);
            scene.add(group);
            worldObjects.push(group);
        }

        function findNearestHouse(pos) {
            let best = null, bestD = Infinity;
            worldObjects.forEach(o => {
                if (o.userData.type === 'house' && o.userData.hp > 0) {
                    const d = o.position.distanceTo(pos);
                    if (d < bestD) { bestD = d; best = o; }
                }
            });
            return best;
        }

        // Walk a unit toward a target on the ground; updates rotation and walk bob
        function walkBuilder(o, ud, target) {
            const dx = target.x - o.position.x;
            const dz = target.z - o.position.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist > 0.1) {
                const stepX = (dx / dist) * ud.speed;
                const stepZ = (dz / dist) * ud.speed;
                o.position.x += stepX;
                o.position.z += stepZ;
                o.rotation.y = Math.atan2(stepX, stepZ);
                ud.walkPhase = (ud.walkPhase || 0) + 0.25;
                o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.15;
            }
        }

        function pickNearbyTarget(pos, home) {
            // Pick a wander point near home, scaled by house footprint
            const center = home ? home.position : pos;
            const fp = home && home.userData.footprint ? home.userData.footprint : 8;
            const angle = Math.random() * Math.PI * 2;
            const radius = fp * 0.7 + Math.random() * fp * 1.8;
            return new THREE.Vector3(
                center.x + Math.cos(angle) * radius,
                0,
                center.z + Math.sin(angle) * radius
            );
        }

        // --- DEBRIS: now have HP, can be burned and destroyed ---
        function shatter(pos, count, baseColor, force = 1.0) {
            for (let i = 0; i < count; i++) {
                const size = 0.5 + Math.random() * 1.5;
                const mat = new THREE.MeshStandardMaterial({ color: baseColor, transparent: true, opacity: 1.0 });
                const d = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mat);
                d.position.copy(pos).add(new THREE.Vector3((Math.random()-0.5)*5, Math.random()*4, (Math.random()-0.5)*5));
                d.userData = {
                    velocity: new THREE.Vector3((Math.random()-0.5)*1.5*force, (1 + Math.random()*2)*force, (Math.random()-0.5)*1.5*force),
                    angularVel: new THREE.Vector3((Math.random()-0.5)*0.3, (Math.random()-0.5)*0.3, (Math.random()-0.5)*0.3),
                    life: 1.0,
                    settled: false,
                    hp: 30,
                    onFire: false,
                    originalColor: baseColor
                };
                d.castShadow = true;
                scene.add(d);
                debris.push(d);
            }
        }

        function createFireParticle(pos, isSmoke = false) {
            const p = new THREE.Mesh(
                new THREE.SphereGeometry(0.3 + Math.random()*0.5),
                new THREE.MeshBasicMaterial({
                    color: isSmoke ? 0x444444 : (Math.random() > 0.5 ? 0xff6600 : 0xffcc00),
                    transparent: true, opacity: 0.9
                })
            );
            p.position.copy(pos).add(new THREE.Vector3((Math.random()-0.5)*2, Math.random()*2, (Math.random()-0.5)*2));
            p.userData = { vel: new THREE.Vector3((Math.random()-0.5)*0.1, 0.2 + Math.random()*0.3, (Math.random()-0.5)*0.1), life: 1.0 };
            scene.add(p);
            fireParticles.push(p);
        }

        function executeWeapon(type, pt) {
            if (type === 'fire') {
                // Set things on fire WITHOUT applying explosive force.
                for(let i=0; i<15; i++) {
                    const spark = pt.clone().add(new THREE.Vector3((Math.random()-0.5)*12, 0, (Math.random()-0.5)*12));
                    createFireParticle(spark);
                }
                igniteRadius(pt, 18, true); // direct flamethrower includes fallen logs
            } else if (type === 'lavaflood') {
                spawnLavaStream(pt);
            } else if (type === 'cracker') {
                spawnPlanetCracker(pt);
            } else if (type === 'leviathan') {
                spawnLeviathan(pt);
            } else if (type === 'kraken') {
                spawnKraken(pt);
            } else if (type === 'vortex') {
                spawnTornado(pt);
            } else if (type === 'quake') {
                earthquake();
            } else if (type === 'napalm') {
                explode(pt, 45, 0xff7700);
                applyBlast(pt, 60, 0.2, 0.05, 30, true, true); // mostly fire, low force
                igniteRadius(pt, 60);
            } else if (type === 'cluster') {
                for(let i=0; i<10; i++) {
                    setTimeout(() => {
                        const p = pt.clone().add(new THREE.Vector3((Math.random()-0.5)*75, 0, (Math.random()-0.5)*75));
                        explode(p, 18, 0xffffff);
                        applyBlast(p, 35, 8, 1.5, 150);
                    }, i * 200);
                }
            } else if (type === 'nuke') {
                explode(pt, 140, 0xffdd88);
                applyBlast(pt, 600, 50, 14, 5000, true); // overwhelming damage to guarantee shattering
            } else if (type === 'blackhole') {
                singularityPoint = pt.clone();
                setTimeout(() => singularityPoint = null, 8000);
            } else if (type === 'meteor') {
                launchMeteor(pt);
            } else if (type === 'tsunami') {
                spawnTsunami(pt);
            } else if (type === 'volcano') {
                spawnVolcano(pt);
            }
        }

        // --- METEOR: constant velocity, no lerp slowdown ---
        function launchMeteor(targetPt) {
            const m = new THREE.Mesh(
                new THREE.SphereGeometry(15),
                new THREE.MeshStandardMaterial({ color: 0xffaa44, emissive: 0xff5500, emissiveIntensity: 2 })
            );
            const startPos = new THREE.Vector3(targetPt.x + 200, 500, targetPt.z + 200);
            m.position.copy(startPos);
            scene.add(m);

            const direction = new THREE.Vector3().subVectors(targetPt, startPos).normalize();
            const speed = 6.5; // constant — no slowdown

            const trail = [];
            const anim = () => {
                m.position.add(direction.clone().multiplyScalar(speed));
                // Smoke trail
                if (Math.random() < 0.7) {
                    const t = new THREE.Mesh(
                        new THREE.SphereGeometry(3 + Math.random()*2),
                        new THREE.MeshBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.6 })
                    );
                    t.position.copy(m.position);
                    t.userData = { life: 1.0 };
                    scene.add(t);
                    trail.push(t);
                }
                // Fade trail
                for (let i = trail.length - 1; i >= 0; i--) {
                    trail[i].userData.life -= 0.015;
                    trail[i].material.opacity = trail[i].userData.life * 0.6;
                    trail[i].scale.multiplyScalar(1.02);
                    if (trail[i].userData.life <= 0) {
                        scene.remove(trail[i]);
                        trail.splice(i, 1);
                    }
                }

                if (m.position.y <= 6) {
                    scene.remove(m);
                    explode(targetPt, 90, 0xff8844);
                    applyBlast(targetPt, 280, 40, 10, 3000, true);
                    // Clean up remaining trail
                    setTimeout(() => trail.forEach(t => scene.remove(t)), 1500);
                    return;
                }
                requestAnimationFrame(anim);
            };
            anim();
        }

        // --- TORNADO: visible mesh + corrected physics, supports multiple ---
        function spawnTornado(pt) {
            const mesh = new THREE.Group();
            const segments = 8;
            for (let i = 0; i < segments; i++) {
                const radiusTop = 2 + i * 4;
                const radiusBottom = 1 + i * 3.5;
                const h = 12;
                const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, h, 16, 1, true);
                const mat = new THREE.MeshBasicMaterial({
                    color: 0x6b7280,
                    transparent: true,
                    opacity: 0.35 - i * 0.02,
                    side: THREE.DoubleSide
                });
                const seg = new THREE.Mesh(geo, mat);
                seg.position.y = 6 + i * h;
                mesh.add(seg);
            }
            mesh.position.copy(pt);
            mesh.position.y = 0;
            scene.add(mesh);

            tornadoes.push({
                mesh: mesh,
                point: pt.clone(),
                age: 0
            });
        }

        function despawnTornado(t) {
            if (t.mesh) {
                scene.remove(t.mesh);
                t.mesh.traverse(c => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
            }
        }

        function despawnAllTornadoes() {
            tornadoes.forEach(despawnTornado);
            tornadoes = [];
        }

        // --- TSUNAMI: realistic breaking wave with proper profile, foam, spray, and turbulent trail ---
        function spawnTsunami(pt) {
            // Direction: sweep from clicked point's side toward the opposite side.
            const dir = pt.x < 0 ? 1 : -1;
            const startX = -dir * (WORLD_SIZE + 40);

            const waveGroup = new THREE.Group();

            const waveLength = WORLD_SIZE * 2.6;
            const waveHeight = 32;

            // === 1. WAVE BODY ===
            // Build a 2D cross-section profile of a breaking wave:
            // - gentle sloped back rising from sea level
            // - sharp peak/crest
            // - curling lip overhanging the leading face
            // - near-vertical leading face plunging back to sea level
            // The shape is in (x, y); we extrude along Z to make the wave length.
            const profile = new THREE.Shape();
            // We design the profile facing +x. Mirror via dir later.
            profile.moveTo(-30, 0);                // far back at sea level
            profile.lineTo(-22, 1.5);              // gentle rise
            profile.lineTo(-15, 5);                // building swell
            profile.lineTo(-8, 12);
            profile.lineTo(-2, 22);
            profile.bezierCurveTo(2, 30, 6, 33, 8, 32);   // crest curls forward
            profile.bezierCurveTo(11, 30, 12, 26, 10, 22); // tip of curl
            profile.bezierCurveTo(7, 19, 4, 18, 3, 14);    // back of barrel mouth
            profile.lineTo(5, 8);                  // leading face plunging
            profile.lineTo(7, 0);                  // base of leading face
            profile.lineTo(-30, 0);                // close back to start

            const extrudeSettings = {
                steps: 1,
                depth: waveLength,
                bevelEnabled: false
            };
            const bodyGeo = new THREE.ExtrudeGeometry(profile, extrudeSettings);
            // Center extrusion along Z
            bodyGeo.translate(0, 0, -waveLength / 2);
            // Mirror for direction (-x dir wave is the mirror image)
            if (dir < 0) bodyGeo.scale(-1, 1, 1);

            const waterMat = new THREE.MeshStandardMaterial({
                color: 0x1d5a85,
                transparent: true,
                opacity: 0.88,
                roughness: 0.15,
                metalness: 0.4,
                emissive: 0x07304a,
                emissiveIntensity: 0.25,
                side: THREE.DoubleSide
            });
            const body = new THREE.Mesh(bodyGeo, waterMat);
            body.castShadow = true;
            body.receiveShadow = true;
            waveGroup.add(body);

            // === 2. INNER FACE (translucent darker layer that suggests depth) ===
            // A second extrusion, slightly smaller, with stronger blue
            const innerProfile = new THREE.Shape();
            innerProfile.moveTo(-28, 0.5);
            innerProfile.lineTo(-15, 4);
            innerProfile.lineTo(-5, 16);
            innerProfile.bezierCurveTo(0, 25, 4, 28, 6, 27);
            innerProfile.bezierCurveTo(8, 25, 9, 22, 7, 19);
            innerProfile.lineTo(4, 8);
            innerProfile.lineTo(6, 0.5);
            innerProfile.lineTo(-28, 0.5);
            const innerGeo = new THREE.ExtrudeGeometry(innerProfile, extrudeSettings);
            innerGeo.translate(0, 0, -waveLength / 2);
            if (dir < 0) innerGeo.scale(-1, 1, 1);
            const innerMat = new THREE.MeshStandardMaterial({
                color: 0x0a3957,
                transparent: true,
                opacity: 0.55,
                roughness: 0.4
            });
            const inner = new THREE.Mesh(innerGeo, innerMat);
            waveGroup.add(inner);

            // === 3. FOAM CHURN: irregular distributed white blobs along the crest ===
            const foamBlobs = [];
            const foamMat = new THREE.MeshStandardMaterial({
                color: 0xf5fbff,
                transparent: true,
                opacity: 0.95,
                emissive: 0xffffff,
                emissiveIntensity: 0.35,
                roughness: 0.9
            });
            for (let i = 0; i < 80; i++) {
                const z = (Math.random() - 0.5) * waveLength * 0.95;
                // Foam concentrated near crest x position (-2..10) and curl tip
                const xOffset = -3 + Math.random() * 12;
                const yOffset = 22 + Math.random() * 8;
                const size = 1.2 + Math.random() * 2.6;
                const blobGeo = new THREE.SphereGeometry(size, 8, 6);
                const blob = new THREE.Mesh(blobGeo, foamMat.clone());
                blob.position.set(dir * xOffset, yOffset, z);
                blob.userData = {
                    basePos: blob.position.clone(),
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.05 + Math.random() * 0.1
                };
                foamBlobs.push(blob);
                waveGroup.add(blob);
            }

            // === 4. BREAKING-FACE FOAM: sliding down the leading face ===
            for (let i = 0; i < 40; i++) {
                const z = (Math.random() - 0.5) * waveLength * 0.95;
                const yOffset = 4 + Math.random() * 16;
                const xOffset = 6 + Math.random() * 3;
                const size = 0.8 + Math.random() * 1.8;
                const blobGeo = new THREE.SphereGeometry(size, 6, 5);
                const blob = new THREE.Mesh(blobGeo, foamMat.clone());
                blob.material.opacity = 0.7 + Math.random() * 0.25;
                blob.position.set(dir * xOffset, yOffset, z);
                blob.userData = {
                    basePos: blob.position.clone(),
                    phase: Math.random() * Math.PI * 2,
                    speed: 0.08 + Math.random() * 0.1
                };
                foamBlobs.push(blob);
                waveGroup.add(blob);
            }

            // === 5. TURBULENT FLOODED TRAIL: bumpy plane behind the wave ===
            const trailLen = WORLD_SIZE * 3.2;
            const trailWidth = waveLength;
            const trailGeo = new THREE.PlaneGeometry(trailLen, trailWidth, 50, 30);
            // Random vertex displacement for chop
            const trailPos = trailGeo.attributes.position;
            for (let i = 0; i < trailPos.count; i++) {
                trailPos.setZ(i, Math.random() * 1.4);
            }
            trailGeo.computeVertexNormals();
            const trailMat = new THREE.MeshStandardMaterial({
                color: 0x144863,
                transparent: true,
                opacity: 0.65,
                roughness: 0.3,
                metalness: 0.3,
                emissive: 0x062234,
                emissiveIntensity: 0.2
            });
            const trail = new THREE.Mesh(trailGeo, trailMat);
            trail.rotation.x = -Math.PI / 2;
            trail.position.y = 0.4;
            // Position trail behind the wave (opposite to its travel direction)
            trail.position.x = -dir * trailLen / 2;
            waveGroup.add(trail);

            // Foam streaks on the turbulent trail surface
            const trailFoam = [];
            const trailFoamMat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.55
            });
            for (let i = 0; i < 60; i++) {
                const streak = new THREE.Mesh(
                    new THREE.PlaneGeometry(2 + Math.random() * 6, 0.8 + Math.random() * 1.2),
                    trailFoamMat.clone()
                );
                streak.rotation.x = -Math.PI / 2;
                streak.rotation.z = Math.random() * Math.PI;
                streak.position.set(
                    -dir * Math.random() * trailLen * 0.9,
                    0.6,
                    (Math.random() - 0.5) * waveLength * 0.95
                );
                streak.userData = { basePhase: Math.random() * Math.PI * 2 };
                trailFoam.push(streak);
                waveGroup.add(streak);
            }

            waveGroup.position.set(startX, 0, 0);
            scene.add(waveGroup);

            tsunamis.push({
                mesh: waveGroup,
                body: body,
                inner: inner,
                trail: trail,
                trailGeo: trailGeo,
                trailMat: trailMat,
                foamBlobs: foamBlobs,
                trailFoam: trailFoam,
                position: startX,
                dir: dir,
                speed: 1.5,
                age: 0,
                lifeMax: 700
            });
        }

        function despawnTsunami(t) {
            scene.remove(t.mesh);
            t.mesh.traverse(c => {
                if (c.isMesh) {
                    c.geometry.dispose();
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material.dispose();
                }
            });
        }

        function despawnAllTsunamis() {
            tsunamis.forEach(despawnTsunami);
            tsunamis = [];
        }

        // --- VOLCANO: erupting cone, lava bombs, lava pool ---
        function spawnVolcano(pt) {
            const group = new THREE.Group();

            // === SIZE ===
            const radius = 28 + Math.random() * 8;
            const height = 38 + Math.random() * 12;

            // === CONE: distorted for craggy rocky look, with vertex colors for blackened top ===
            const segments = 24;
            const heightSegs = 12;
            const coneGeo = new THREE.ConeGeometry(radius, height, segments, heightSegs, true);
            const pos = coneGeo.attributes.position;
            // Add per-vertex displacement and prepare color attribute
            const colors = new Float32Array(pos.count * 3);
            for (let i = 0; i < pos.count; i++) {
                const x = pos.getX(i);
                const y = pos.getY(i);
                const z = pos.getZ(i);
                // Y in cone geometry goes from -h/2 (base) to h/2 (tip). Normalize 0..1.
                const yNorm = (y + height / 2) / height;
                // Don't displace tip or base too much
                const tipFactor = Math.abs(y - height / 2) < 1.5 ? 0.1 : 1;
                const baseFactor = Math.abs(y + height / 2) < 1.5 ? 0.2 : 1;
                const noise = (Math.random() - 0.5) * 3.5 * tipFactor * baseFactor;
                pos.setX(i, x + noise);
                pos.setZ(i, z + noise * 0.7);
                pos.setY(i, y + (Math.random() - 0.5) * 1.2 * tipFactor * baseFactor);

                // Color: dark grey-brown at base, blackened brown near top, red glow at very tip
                let r, g, b;
                if (yNorm > 0.85) {
                    // Near rim: blackened with red streaks
                    const t = (yNorm - 0.85) / 0.15;
                    r = 0.3 + t * 0.5;
                    g = 0.15 + t * 0.1;
                    b = 0.1;
                } else if (yNorm > 0.5) {
                    // Upper slopes: very dark, scorched
                    const t = (yNorm - 0.5) / 0.35;
                    r = 0.25 - t * 0.13;
                    g = 0.18 - t * 0.1;
                    b = 0.13 - t * 0.07;
                } else {
                    // Lower slopes: brown rock
                    r = 0.32 + (Math.random() - 0.5) * 0.06;
                    g = 0.22 + (Math.random() - 0.5) * 0.05;
                    b = 0.16 + (Math.random() - 0.5) * 0.04;
                }
                colors[i * 3]     = r;
                colors[i * 3 + 1] = g;
                colors[i * 3 + 2] = b;
            }
            coneGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
            coneGeo.computeVertexNormals();

            const coneMat = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: 0.95,
                flatShading: true,
                side: THREE.DoubleSide
            });
            const cone = new THREE.Mesh(coneGeo, coneMat);
            cone.position.y = height / 2;
            cone.castShadow = true;
            cone.receiveShadow = true;
            group.add(cone);

            // === LAVA STREAMS down the sides ===
            const lavaStreamMat = new THREE.MeshBasicMaterial({
                color: 0xff5500,
                transparent: true,
                opacity: 0.9
            });
            const lavaStreams = [];
            const streamCount = 4 + Math.floor(Math.random() * 4);
            for (let s = 0; s < streamCount; s++) {
                const angle = (s / streamCount) * Math.PI * 2 + Math.random() * 0.5;
                const points = [];
                const streamSegs = 8;
                for (let i = 0; i <= streamSegs; i++) {
                    const t = i / streamSegs;
                    const yPos = height * (1 - t);
                    const r = radius * t;
                    const wobble = (Math.random() - 0.5) * 1.5;
                    points.push(new THREE.Vector3(
                        Math.cos(angle + wobble * 0.05) * r * 0.9,
                        yPos,
                        Math.sin(angle + wobble * 0.05) * r * 0.9
                    ));
                }
                const curve = new THREE.CatmullRomCurve3(points);
                const tubeGeo = new THREE.TubeGeometry(curve, 16, 0.8, 6, false);
                const stream = new THREE.Mesh(tubeGeo, lavaStreamMat.clone());
                lavaStreams.push(stream);
                group.add(stream);
            }

            // === CRATER RIM (jagged dark rocks) ===
            const rimRadius = radius * 0.18;
            for (let i = 0; i < 12; i++) {
                const ang = (i / 12) * Math.PI * 2;
                const rockSize = 1 + Math.random() * 1.5;
                const rock = new THREE.Mesh(
                    new THREE.DodecahedronGeometry(rockSize, 0),
                    new THREE.MeshStandardMaterial({ color: 0x1a0e08, roughness: 1, flatShading: true })
                );
                rock.position.set(
                    Math.cos(ang) * rimRadius,
                    height - 0.3,
                    Math.sin(ang) * rimRadius
                );
                rock.rotation.set(Math.random(), Math.random(), Math.random());
                rock.castShadow = true;
                group.add(rock);
            }

            // === LAVA IN CRATER (bubbling) ===
            const craterLavaGeo = new THREE.CircleGeometry(rimRadius * 0.85, 18);
            const craterLavaMat = new THREE.MeshBasicMaterial({ color: 0xff7700 });
            const lavaCore = new THREE.Mesh(craterLavaGeo, craterLavaMat);
            lavaCore.rotation.x = -Math.PI / 2;
            lavaCore.position.y = height - 0.5;
            group.add(lavaCore);

            // Bubbling bumps inside crater
            const lavaBubbles = [];
            for (let i = 0; i < 6; i++) {
                const b = new THREE.Mesh(
                    new THREE.SphereGeometry(0.6 + Math.random() * 0.4, 8, 6),
                    new THREE.MeshBasicMaterial({ color: 0xffaa00 })
                );
                const ang = Math.random() * Math.PI * 2;
                const r = Math.random() * rimRadius * 0.7;
                b.position.set(Math.cos(ang) * r, height - 0.3, Math.sin(ang) * r);
                b.userData = { phase: Math.random() * Math.PI * 2, baseY: height - 0.3 };
                group.add(b);
                lavaBubbles.push(b);
            }

            // Crater glow light (strong)
            const craterLight = new THREE.PointLight(0xff5500, 4, 100);
            craterLight.position.y = height + 3;
            group.add(craterLight);

            // === SMOKE PLUME (persistent column rising from crater) ===
            const smokeParticles = [];

            // === LAVA POOL at base (grows over time) ===
            const poolGeo = new THREE.CircleGeometry(1, 32);
            const poolMat = new THREE.MeshStandardMaterial({
                color: 0xff4500,
                emissive: 0xff2200,
                emissiveIntensity: 0.8,
                roughness: 0.6,
                transparent: true,
                opacity: 0.95
            });
            const lavaPool = new THREE.Mesh(poolGeo, poolMat);
            lavaPool.rotation.x = -Math.PI / 2;
            lavaPool.position.y = 0.15;
            group.add(lavaPool);

            group.position.copy(pt);
            group.position.y = 0;
            scene.add(group);

            volcanoes.push({
                mesh: group,
                point: pt.clone(),
                age: 0,
                lifeMax: 9000, // ~2.5 minutes — very gradual
                lavaPool: lavaPool,
                lavaCore: lavaCore,
                lavaCoreMat: craterLavaMat,
                lavaBubbles: lavaBubbles,
                lavaStreams: lavaStreams,
                craterLight: craterLight,
                smokeParticles: smokeParticles,
                poolRadius: 1,
                eruptionIntensity: 1.0, // 0..1, fades over time
                radius: radius,
                height: height
            });

            // Initial eruption blast
            for (let i = 0; i < 8; i++) {
                setTimeout(() => spawnLavaBomb(pt, height), i * 80);
            }
        }

        function spawnLavaStream(pt) {
            // Create a growing lava pool at the impact point
            const poolGeo = new THREE.CircleGeometry(1, 24);
            const poolMat = new THREE.MeshStandardMaterial({
                color: 0xff5500,
                emissive: 0xff3300,
                emissiveIntensity: 0.9,
                roughness: 0.5,
                transparent: true,
                opacity: 0.95
            });
            const pool = new THREE.Mesh(poolGeo, poolMat);
            pool.rotation.x = -Math.PI / 2;
            pool.position.copy(pt);
            pool.position.y = 0.12;
            scene.add(pool);

            // Stream visual: a tall thin orange column from sky to ground
            const streamHeight = 60;
            const streamGeo = new THREE.CylinderGeometry(0.5, 0.7, streamHeight, 8, 1, true);
            const streamMat = new THREE.MeshBasicMaterial({
                color: 0xff7711,
                transparent: true,
                opacity: 0.85,
                side: THREE.DoubleSide
            });
            const stream = new THREE.Mesh(streamGeo, streamMat);
            stream.position.set(pt.x, streamHeight / 2, pt.z);
            scene.add(stream);

            // Glow light at the impact
            const glow = new THREE.PointLight(0xff5500, 3, 60);
            glow.position.set(pt.x, 4, pt.z);
            scene.add(glow);

            const streamObj = {
                pool: pool,
                stream: stream,
                glow: glow,
                point: pt.clone(),
                age: 0,
                lifeMax: 720, // ~12 sec of pouring
                poolRadius: 1,
                drops: []
            };
            lavaStreams.push(streamObj);

            // Initial impact splatter
            for (let i = 0; i < 8; i++) {
                spawnLavaBomb(pt, 12);
            }
        }

        // ===== PLANET CRACKER: Solar Smash-style ground fissure =====
        let crackerFissures = []; // active fissure animations

        function spawnPlanetCracker(pt) {
            // Random crack direction
            const crackAngle = Math.random() * Math.PI;
            const crackLength = 80 + Math.random() * 60;
            const crackDir = new THREE.Vector3(Math.cos(crackAngle), 0, Math.sin(crackAngle));

            // Phase 1: energy beam from sky (lightning-like column)
            const beamMat = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.95
            });
            const beamH = 200;
            const beam = new THREE.Mesh(
                new THREE.CylinderGeometry(0.4, 2, beamH, 8, 1, true),
                beamMat
            );
            beam.position.set(pt.x, beamH / 2, pt.z);
            scene.add(beam);

            // Inner brighter core
            const coreMat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.9 });
            const core = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.8, beamH, 6), coreMat);
            core.position.copy(beam.position);
            scene.add(core);

            // Immediate massive blast at impact
            setTimeout(() => {
                scene.remove(beam);
                scene.remove(core);

                // SHOCKWAVE: huge blast at center
                explode(pt, 60, 0xff6600);
                applyBlast(pt, 80, 12, 2.5, 2000, true, true);
                igniteRadius(pt, 50, true);

                // Giant glow light
                const impactLight = new THREE.PointLight(0xff4400, 8, 150);
                impactLight.position.set(pt.x, 10, pt.z);
                scene.add(impactLight);
                setTimeout(() => scene.remove(impactLight), 3000);

                // Spawn the ground fissure
                spawnFissure(pt, crackDir, crackLength);

            }, 300); // 300ms beam strike delay
        }

        function spawnFissure(origin, dir, length) {
            const perp = new THREE.Vector3(-dir.z, 0, dir.x);
            const fissureWidth = 4 + Math.random() * 3;
            const segments = Math.floor(length / 6);

            // Build the fissure mesh: a long jagged crack in the ground
            const positions = [];
            const indices = [];
            const segLen = length / segments;

            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const along = i * segLen;
                const wobble = (Math.random() - 0.5) * 4; // jagged edges
                const hw = fissureWidth * (1 - Math.abs(t - 0.5) * 1.2) * (0.7 + Math.random() * 0.3);
                // Center line point
                const cx = origin.x + dir.x * (along - length / 2) + perp.x * wobble;
                const cz = origin.z + dir.z * (along - length / 2) + perp.z * wobble;
                // Left edge
                positions.push(cx - perp.x * hw, 0.1, cz - perp.z * hw);
                // Right edge
                positions.push(cx + perp.x * hw, 0.1, cz + perp.z * hw);
                if (i < segments) {
                    const a = i * 2;
                    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
                }
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const fissureMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: 0xff2200,
                emissive: 0xff1100,
                side: THREE.DoubleSide
            }));
            scene.add(fissureMesh);

            // Dark cracked earth overlay (slightly above to show as charred edges)
            const crackMat = new THREE.MeshStandardMaterial({ color: 0x1a0a00, roughness: 1 });

            // Staggered secondary blasts + lava eruptions along the crack
            const blastCount = 6 + Math.floor(Math.random() * 5);
            for (let i = 0; i < blastCount; i++) {
                const delay = 100 + i * 120 + Math.random() * 80;
                const t = (i + 0.5) / blastCount;
                const along = (t - 0.5) * length;
                const bx = origin.x + dir.x * along + (Math.random() - 0.5) * 6;
                const bz = origin.z + dir.z * along + (Math.random() - 0.5) * 6;
                const blastPos = new THREE.Vector3(bx, 0, bz);
                setTimeout(() => {
                    explode(blastPos, 20 + Math.random() * 15, 0xff5500);
                    applyBlast(blastPos, 30, 6, 1.5, 600, true, true);
                    igniteRadius(blastPos, 20, true);
                    // Shoot lava bombs upward from each fissure point
                    for (let j = 0; j < 5; j++) {
                        setTimeout(() => spawnLavaBomb(blastPos, 2), j * 60);
                    }
                    // Lava stream at each crack point
                    if (Math.random() < 0.5) spawnLavaStream(blastPos);
                }, delay);
            }

            // Edge rocks: throw chunks outward along the crack
            for (let i = 0; i < 20; i++) {
                const delay = 200 + Math.random() * 600;
                setTimeout(() => {
                    const t = Math.random();
                    const along = (t - 0.5) * length;
                    const bx = origin.x + dir.x * along + (Math.random() - 0.5) * 4;
                    const bz = origin.z + dir.z * along + (Math.random() - 0.5) * 4;
                    const chunkPos = new THREE.Vector3(bx, 0, bz);
                    shatter(chunkPos, 8, 0x3d2b1a, 1.5);
                }, delay);
            }

            // Store fissure for cleanup
            crackerFissures.push({
                mesh: fissureMesh,
                age: 0,
                lifeMax: 1800, // stays for 30 sec then fades
            });
        }

        let octopuses = []; // devourer removed
        function updateOctopuses() {}
        // Monarch removed — keep stubs so reset code doesn't crash
        let monarchInstance = null;
        let monarchKeys = {};

        // ===== LEVIATHAN: drilling serpent =====
        let leviathans = [];

        function spawnLeviathan(pt) {
            const skinMat  = new THREE.MeshStandardMaterial({ color: 0x2a1008, roughness: 0.88, metalness: 0.08 });
            const plateMat = new THREE.MeshStandardMaterial({ color: 0x1a0804, roughness: 0.75, metalness: 0.25 });
            const innerMat = new THREE.MeshStandardMaterial({ color: 0x6b1a10, roughness: 0.9, emissive: 0x2a0a05, emissiveIntensity: 0.5 });
            const teethMat = new THREE.MeshStandardMaterial({ color: 0xe8d8b0, roughness: 0.5 });
            const eyeMat   = new THREE.MeshStandardMaterial({ color: 0xff1100, emissive: 0xff0800, emissiveIntensity: 3.5, roughness: 0.1 });

            const BODY_SEGS = 18;
            const SEG_GAP = 16;
            const HEAD_W = 26;

            // ── HEAD (added directly to scene, separate from body) ──────
            const headGroup = new THREE.Group();
            scene.add(headGroup);

            const skull = new THREE.Mesh(new THREE.BoxGeometry(HEAD_W*2, HEAD_W*0.55, HEAD_W*0.9), skinMat);
            skull.position.set(0, HEAD_W*0.12, 0);
            skull.castShadow = true;
            headGroup.add(skull);
            for (let i = 0; i < 8; i++) {
                const h = HEAD_W*(0.08+(i<4?i*0.03:(7-i)*0.03));
                const sc = new THREE.Mesh(new THREE.BoxGeometry(HEAD_W*0.12, h, HEAD_W*0.7), plateMat);
                sc.position.set(-HEAD_W*0.9+i*HEAD_W*0.26, HEAD_W*0.38, 0);
                headGroup.add(sc);
            }
            for (let i = 0; i < 14; i++) {
                const len = 4 + Math.random()*5;
                const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.9+Math.random()*0.5, len, 5), teethMat);
                tooth.position.set(-HEAD_W*0.88+i*HEAD_W*0.135, -HEAD_W*0.2, (i%2===0?HEAD_W*0.18:-HEAD_W*0.18));
                tooth.rotation.z = -Math.PI/2;
                headGroup.add(tooth);
            }
            const lowerGroup = new THREE.Group();
            lowerGroup.position.set(0, -HEAD_W*0.22, 0);
            headGroup.add(lowerGroup);
            const lowerJaw = new THREE.Mesh(new THREE.BoxGeometry(HEAD_W*1.85, HEAD_W*0.28, HEAD_W*0.78), skinMat);
            lowerJaw.position.y = -HEAD_W*0.14;
            lowerGroup.add(lowerJaw);
            for (let i = 0; i < 12; i++) {
                const len = 3.5 + Math.random()*4;
                const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.8+Math.random()*0.4, len, 5), teethMat);
                tooth.position.set(-HEAD_W*0.8+i*HEAD_W*0.145, HEAD_W*0.03, (i%2===0?HEAD_W*0.16:-HEAD_W*0.16));
                tooth.rotation.z = Math.PI/2;
                lowerGroup.add(tooth);
            }
            const throat = new THREE.Mesh(new THREE.SphereGeometry(HEAD_W*0.28, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff4400, transparent: true, opacity: 0.7 }));
            throat.position.set(-HEAD_W*0.6, -HEAD_W*0.1, 0);
            lowerGroup.add(throat);
            const throatLight = new THREE.PointLight(0xff3300, 5, 100);
            throatLight.position.set(-HEAD_W*0.5, 0, 0);
            lowerGroup.add(throatLight);
            for (const ez of [-HEAD_W*0.3, HEAD_W*0.3]) {
                const eye = new THREE.Mesh(new THREE.SphereGeometry(3, 10, 8), eyeMat);
                eye.position.set(HEAD_W*0.7, HEAD_W*0.2, ez);
                headGroup.add(eye);
            }
            const eyeLight = new THREE.PointLight(0xff1100, 3, 100);
            eyeLight.position.set(HEAD_W*0.8, HEAD_W*0.2, 0);
            headGroup.add(eyeLight);

            // ── BODY SEGMENTS (scene-parented, follow head via position IK) ─
            const segGroups = [];
            const segPos = [];   // world positions driving segment placement
            const segYaw = [];   // smooth yaw per segment
            const segPitch = []; // smooth pitch per segment

            for (let i = 0; i < BODY_SEGS; i++) {
                const t = i/(BODY_SEGS-1);
                const radius = Math.max(4, HEAD_W*0.42 - i*1.05);
                const sg = new THREE.Group();
                scene.add(sg);
                const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 10, 8), i%4===1?innerMat:skinMat);
                body.scale.set(1.25, 0.8, 1);
                body.castShadow = true;
                sg.add(body);
                const nP = i<4?2:(i<11?3:2);
                const pH = Math.max(2, (12-i*0.5))*(1-t*0.4);
                for (let p = 0; p < nP; p++) {
                    const ph = pH*(0.7+Math.random()*0.5)*(p%2===0?1:0.6);
                    const plate = new THREE.Mesh(new THREE.BoxGeometry(radius*0.35+Math.random()*radius*0.15, ph, radius*0.18), plateMat);
                    plate.position.set((p-(nP-1)/2)*radius*0.55, radius*0.7+ph*0.35, 0);
                    plate.rotation.z = (Math.random()-0.5)*0.25;
                    sg.add(plate);
                }
                if (i%2===0) {
                    const belly = new THREE.Mesh(new THREE.BoxGeometry(radius*1.1, radius*0.12, radius*0.7), innerMat);
                    belly.position.y = -radius*0.7;
                    sg.add(belly);
                }
                segGroups.push(sg);
                segPos.push(new THREE.Vector3());
                segYaw.push(0);
                segPitch.push(0);
            }

            const camYaw = Math.atan2(camera.position.x - pt.x, camera.position.z - pt.z);
            const spawnAngle = camYaw + Math.PI + (Math.random()-0.5)*0.8;
            const sx = pt.x + Math.cos(spawnAngle)*WORLD_SIZE*1.6;
            const sz = pt.z + Math.sin(spawnAngle)*WORLD_SIZE*1.6;
            const sy = 90 + Math.random()*60;

            for (let i = 0; i < BODY_SEGS; i++) {
                segPos[i].set(
                    sx + Math.cos(spawnAngle+Math.PI)*i*SEG_GAP,
                    sy,
                    sz + Math.sin(spawnAngle+Math.PI)*i*SEG_GAP
                );
                segGroups[i].position.copy(segPos[i]);
                segYaw[i] = Math.atan2(pt.x-sx, pt.z-sz);
                segPitch[i] = 0;
            }

            const headPos = new THREE.Vector3(sx, sy, sz);
            headGroup.position.copy(headPos);

            leviathans.push({
                headGroup, lowerGroup, segGroups, segPos, segYaw, segPitch,
                headPos, HEAD_W, SEG_GAP, BODY_SEGS,
                age: 0, lifeMax: 2400,
                headYaw: Math.atan2(pt.x-sx, pt.z-sz),
                headPitch: -0.05,
                chompOpen: 0,
                pt: pt.clone(),
                tunnelDir: null, tunnelTurns: 0,
                underground: false, exitTarget: null,
                phase: 'approach', phaseTimer: 0,
            });
        }

        function updateLeviathans() {
            for (let li = leviathans.length - 1; li >= 0; li--) {
                const lev = leviathans[li];
                lev.age++;
                lev.phaseTimer++;

                // ── HEAD STEERING ────────────────────────────────────────
                let desiredYaw = lev.headYaw;
                let desiredPitch = -0.05;
                let spd = 2.0;

                if (lev.phase === 'approach') {
                    const toT = new THREE.Vector3(lev.pt.x-lev.headPos.x, 0, lev.pt.z-lev.headPos.z);
                    desiredYaw = Math.atan2(toT.x, toT.z) + Math.sin(lev.age*0.012)*0.25;
                    desiredPitch = -0.06 + Math.sin(lev.age*0.018)*0.04;
                    spd = 1.8;
                    if (toT.length() < 80) { lev.phase='dive'; lev.phaseTimer=0; }

                } else if (lev.phase === 'dive') {
                    desiredPitch = -0.7 - lev.phaseTimer*0.008;
                    if (desiredPitch < -1.2) desiredPitch = -1.2;
                    const toT = new THREE.Vector3(lev.pt.x-lev.headPos.x, 0, lev.pt.z-lev.headPos.z);
                    desiredYaw = Math.atan2(toT.x, toT.z);
                    spd = 2.4;
                    lev.chompOpen = Math.min(1, lev.chompOpen+0.03);
                    if (lev.headPos.y <= 0) {
                        lev.phase='tunnel'; lev.phaseTimer=0;
                        lev.tunnelDir = new THREE.Vector3(Math.sin(lev.headYaw),-0.3,Math.cos(lev.headYaw)).normalize();
                        lev.tunnelTurns=0; lev.underground=true;
                        const ep = lev.headPos.clone();
                        applyBlast(ep,70,14,4,1800,false,true);
                        explode(ep,55,0xff2200);
                        igniteRadius(ep,45,true);
                        shatter(ep,25,0x3a2010,2.5);
                    }

                } else if (lev.phase === 'tunnel') {
                    if (lev.phaseTimer%80===0 && lev.tunnelTurns<5) {
                        lev.tunnelDir.x += (Math.random()-0.5)*0.6;
                        lev.tunnelDir.z += (Math.random()-0.5)*0.6;
                        lev.tunnelDir.y = -0.1+Math.random()*0.3;
                        lev.tunnelDir.normalize();
                        lev.tunnelTurns++;
                        const tp = lev.headPos.clone();
                        applyBlast(tp,55,12,3,800,false,true);
                        shatter(tp,20,0x2a1a0a,2);
                        igniteRadius(tp,30,true);
                    }
                    desiredYaw = Math.atan2(lev.tunnelDir.x, lev.tunnelDir.z);
                    desiredPitch = Math.asin(Math.max(-1,Math.min(1,lev.tunnelDir.y)));
                    spd = 3.0;
                    if (lev.phaseTimer%20===0) {
                        const hp = lev.headPos.clone();
                        worldObjects.forEach(obj => {
                            if (obj.userData.frozen||obj.userData.hp<=0) return;
                            const d=obj.position.distanceTo(hp);
                            if (d<50){obj.userData.hp-=80;obj.userData.velocity.set((Math.random()-0.5)*5,6+Math.random()*5,(Math.random()-0.5)*5);}
                        });
                        const sp = new THREE.Vector3(hp.x,0,hp.z);
                        applyBlast(sp,35,6,2,200,false,true);
                        for (let s=0;s<5;s++) createFireParticle(sp.clone().add(new THREE.Vector3((Math.random()-0.5)*20,0,(Math.random()-0.5)*20)),true);
                    }
                    if (lev.phaseTimer>400||lev.tunnelTurns>=5) {
                        lev.phase='exit'; lev.phaseTimer=0;
                        const ea = Math.random()*Math.PI*2;
                        lev.exitTarget = new THREE.Vector3(lev.headPos.x+Math.cos(ea)*120,80,lev.headPos.z+Math.sin(ea)*120);
                    }

                } else if (lev.phase === 'exit') {
                    const toExit = new THREE.Vector3().subVectors(lev.exitTarget, lev.headPos);
                    desiredYaw = Math.atan2(toExit.x, toExit.z);
                    desiredPitch = 0.5+Math.min(0.5,lev.phaseTimer*0.015);
                    spd = 3.5;
                    lev.chompOpen = Math.max(0,lev.chompOpen-0.05);
                    if (lev.headPos.y>5&&lev.underground) {
                        lev.underground=false;
                        const ep=lev.headPos.clone(); ep.y=0;
                        applyBlast(ep,60,13,5,1200,false,true);
                        explode(ep,50,0xff5500);
                        shatter(ep,20,0x3a2010,3);
                    }
                    if (lev.headPos.y>60) { lev.phase='depart'; lev.phaseTimer=0; }

                } else if (lev.phase === 'depart') {
                    desiredPitch=0.35; spd=4.0;
                    lev.chompOpen=Math.max(0,lev.chompOpen-0.02);
                    if (lev.headPos.y>400) {
                        lev.segGroups.forEach(sg=>scene.remove(sg));
                        scene.remove(lev.headGroup);
                        leviathans.splice(li,1);
                        continue;
                    }
                }

                // ── SMOOTH HEAD MOVEMENT ─────────────────────────────────
                let yd = desiredYaw - lev.headYaw;
                while (yd>Math.PI) yd-=Math.PI*2; while (yd<-Math.PI) yd+=Math.PI*2;
                lev.headYaw += yd*0.038;
                lev.headPitch += (desiredPitch-lev.headPitch)*0.045;

                lev.headPos.x += Math.sin(lev.headYaw)*Math.cos(lev.headPitch)*spd;
                lev.headPos.y += Math.sin(lev.headPitch)*spd;
                lev.headPos.z += Math.cos(lev.headYaw)*Math.cos(lev.headPitch)*spd;
                if (!lev.underground&&lev.phase!=='dive'&&lev.phase!=='exit') lev.headPos.y=Math.max(20,lev.headPos.y);

                lev.headGroup.position.copy(lev.headPos);
                lev.headGroup.rotation.y = lev.headYaw - Math.PI/2;
                lev.headGroup.rotation.z = lev.headPitch*0.55;

                lev.lowerGroup.rotation.z = -lev.chompOpen*0.5;
                lev.lowerGroup.position.y = -lev.HEAD_W*0.22 - lev.chompOpen*lev.HEAD_W*0.18;

                // ── BODY CHAIN: segments rigidly track each other at exact SEG_GAP ──
                // Segment[0] tracks head. Each subsequent segment tracks the previous.
                // We use a "bone chain" approach: each segment's position is always exactly
                // SEG_GAP behind the segment ahead of it, with smoothed orientation.
                const headFwd = new THREE.Vector3(
                    Math.sin(lev.headYaw)*Math.cos(lev.headPitch),
                    Math.sin(lev.headPitch),
                    Math.cos(lev.headYaw)*Math.cos(lev.headPitch)
                );
                // Target for seg[0]: directly behind the head
                const seg0Target = lev.headPos.clone().addScaledVector(headFwd, -lev.SEG_GAP);
                // Lerp segment[0] toward target (damped follow, faster lerp = stiffer)
                lev.segPos[0].lerp(seg0Target, 0.25);

                for (let i = 1; i < lev.BODY_SEGS; i++) {
                    const prev = lev.segPos[i-1];
                    const curr = lev.segPos[i];
                    // Vector from curr to prev
                    const diff = new THREE.Vector3().subVectors(prev, curr);
                    const dist = diff.length();
                    // Constrain: curr must be exactly SEG_GAP from prev
                    // Move curr along the diff direction so the distance is correct
                    if (dist > 0.001) {
                        const excess = dist - lev.SEG_GAP;
                        // Strong correction factor (0.8) — segments barely stretch
                        curr.addScaledVector(diff.normalize(), excess * 0.8);
                    }
                }

                // Apply positions and orient each segment to face forward along chain
                for (let i = 0; i < lev.BODY_SEGS; i++) {
                    lev.segGroups[i].position.copy(lev.segPos[i]);
                    // Look-at target: the segment ahead (or head for seg 0)
                    const lookTarget = i === 0 ? lev.headPos : lev.segPos[i-1];
                    const dx = lookTarget.x - lev.segPos[i].x;
                    const dy = lookTarget.y - lev.segPos[i].y;
                    const dz = lookTarget.z - lev.segPos[i].z;
                    const horizDist = Math.sqrt(dx*dx+dz*dz);
                    // Smooth yaw
                    const tYaw = Math.atan2(dx,dz) - Math.PI/2;
                    let yDiff = tYaw - lev.segYaw[i];
                    while (yDiff>Math.PI) yDiff-=Math.PI*2; while (yDiff<-Math.PI) yDiff+=Math.PI*2;
                    lev.segYaw[i] += yDiff*0.3;
                    // Smooth pitch
                    const tPitch = Math.atan2(dy, horizDist);
                    lev.segPitch[i] += (tPitch - lev.segPitch[i])*0.3;
                    lev.segGroups[i].rotation.y = lev.segYaw[i];
                    lev.segGroups[i].rotation.z = lev.segPitch[i]*0.5;
                }

                // Surface destruction while approaching or diving
                if (lev.phase==='approach'||lev.phase==='dive') {
                    const hp2 = new THREE.Vector3(lev.headPos.x,0,lev.headPos.z);
                    worldObjects.forEach(obj=>{
                        if (obj.userData.frozen||obj.userData.hp<=0) return;
                        const d=obj.position.distanceTo(hp2);
                        if (d<35){obj.userData.hp-=40;obj.userData.velocity.set((obj.position.x-hp2.x)*0.2+Math.random(),7+Math.random()*4,(obj.position.z-hp2.z)*0.2+Math.random());}
                        if (obj.userData.type==='mountain'&&d<50){obj.userData.hp-=55;if(obj.userData.hp>0){const sc=Math.max(0.4,obj.userData.hp/obj.userData.maxHp);obj.scale.set(sc,sc*0.85,sc);}}
                    });
                }
            }
        }

        // ===== KRAKEN: Cosmic tentacled entity from a portal =====
        let krakens = [];

        function spawnKraken(pt) {
            if (krakens.length > 0) { showMessage('A Kraken is already attacking!'); return; }

            const PORTAL_RADIUS = 32;
            const TENT_COUNT = 7;
            const TENT_SEGS = 16;
            const SEG_LEN = 8;

            const portalAngle = Math.random() * Math.PI * 2;
            const portalPos = new THREE.Vector3(pt.x + Math.cos(portalAngle)*60, 90, pt.z + Math.sin(portalAngle)*60);

            const portalGroup = new THREE.Group();
            portalGroup.position.copy(portalPos);
            portalGroup.lookAt(pt);
            scene.add(portalGroup);

            const portalCore = new THREE.Mesh(new THREE.CircleGeometry(PORTAL_RADIUS*0.85, 32),
                new THREE.MeshBasicMaterial({ color: 0xff5000, transparent: true, opacity: 0.92 }));
            portalGroup.add(portalCore);
            const innerCore = new THREE.Mesh(new THREE.CircleGeometry(PORTAL_RADIUS*0.5, 32),
                new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.85 }));
            innerCore.position.z = 0.1;
            portalGroup.add(innerCore);

            const haloRings = [];
            for (let r = 0; r < 4; r++) {
                const ring = new THREE.Mesh(
                    new THREE.TorusGeometry(PORTAL_RADIUS*(0.95+r*0.18), 1.2+r*0.6, 8, 36),
                    new THREE.MeshBasicMaterial({ color: [0xff7700,0xff3300,0xaa1100,0x6a0a00][r], transparent:true, opacity:0.7-r*0.12 })
                );
                portalGroup.add(ring);
                haloRings.push({ mesh: ring, dir: r%2===0?1:-1, speed: 0.04+r*0.025 });
            }

            const void_ = new THREE.Mesh(new THREE.CircleGeometry(PORTAL_RADIUS*0.84, 32),
                new THREE.MeshBasicMaterial({ color: 0x050002, transparent:true, opacity:0.97 }));
            void_.position.z = 0.05;
            portalGroup.add(void_);

            const portalLight = new THREE.PointLight(0xff4400, 8, 350);
            portalLight.position.copy(portalPos);
            scene.add(portalLight);

            const tentMat = new THREE.MeshStandardMaterial({ color: 0x080000, roughness:0.7, metalness:0.2 });
            const tipMat  = new THREE.MeshStandardMaterial({ color: 0x1a0408, roughness:0.65, metalness:0.3 });

            const tentacles = [];
            for (let ti = 0; ti < TENT_COUNT; ti++) {
                const pAngle = (ti/TENT_COUNT)*Math.PI*2 + Math.random()*0.4;
                const eR = PORTAL_RADIUS*(0.3+Math.random()*0.6);
                const tGroup = new THREE.Group();
                portalGroup.add(tGroup);
                tGroup.position.set(Math.cos(pAngle)*eR, Math.sin(pAngle)*eR, 0);
                const chain = [];
                let parent = tGroup;
                for (let s = 0; s < TENT_SEGS; s++) {
                    const t = s/(TENT_SEGS-1);
                    const r = Math.max(0.25, 2.4-t*1.9);
                    const pivot = new THREE.Group();
                    pivot.position.z = s===0 ? 0 : SEG_LEN;
                    const seg = new THREE.Mesh(
                        new THREE.CylinderGeometry(r*0.8, r, SEG_LEN+0.1, 8),
                        s>=TENT_SEGS-3 ? tipMat : tentMat
                    );
                    seg.rotation.x = Math.PI/2;
                    seg.position.z = SEG_LEN/2;
                    seg.castShadow = true;
                    pivot.add(seg);
                    if (s<TENT_SEGS-2 && s%2===0) {
                        for (let b=0;b<2;b++) {
                            const bump = new THREE.Mesh(new THREE.SphereGeometry(r*0.25,5,4),
                                new THREE.MeshStandardMaterial({color:0x1a0405,roughness:0.95}));
                            bump.position.set((b-0.5)*r*0.7, -r*0.7, SEG_LEN*0.5);
                            pivot.add(bump);
                        }
                    }
                    parent.add(pivot);
                    chain.push(pivot);
                    parent = pivot;
                }
                tentacles.push({
                    root: tGroup, chain,
                    archPattern: ti%3,
                    emergeDelay: ti*18+Math.floor(Math.random()*12),
                    emergeProg: 0,
                    noiseOff: Math.random()*100,
                    state: 'hidden',
                    stateTimer: 0,
                    target: null,
                    targetWorldPos: null,
                    grabFraction: 0,
                });
            }

            krakens.push({
                portalGroup, portalLight, portalCore, innerCore, haloRings,
                tentacles, portalPos: portalPos.clone(), pt: pt.clone(),
                age: 0, lifeMax: 1200, hp: 4000,
                phase: 'open', phaseTimer: 0, onFire: false,
                PORTAL_RADIUS, TENT_SEGS, SEG_LEN,
                groundChunk: null,
            });
        }

        function _tendrilNoise(t, off, freq) {
            return Math.sin(t*freq+off)*0.55 + Math.sin(t*freq*1.8+off*1.4)*0.28 + Math.sin(t*freq*0.45+off*2.0)*0.17;
        }

        function updateKrakens() {
            for (let ki = krakens.length-1; ki >= 0; ki--) {
                const k = krakens[ki];
                k.age++; k.phaseTimer++;

                // Portal visuals
                k.haloRings.forEach(r => { r.mesh.rotation.z += r.speed*r.dir; });
                const pulse = 0.85+Math.sin(k.age*0.18)*0.15;
                k.portalCore.scale.setScalar(pulse);
                k.innerCore.scale.setScalar(0.7+Math.sin(k.age*0.25)*0.15);
                k.portalLight.intensity = 6+pulse*3;

                if (k.onFire) { k.hp -= 3; k.onFire = false; }
                if (k.hp <= 0 && k.phase !== 'close') {
                    for (let f=0;f<20;f++) {
                        const chunk = new THREE.Mesh(new THREE.SphereGeometry(1.5+Math.random()*3,6,5),
                            new THREE.MeshStandardMaterial({color:0x2a0408,roughness:0.9}));
                        chunk.position.copy(k.portalPos);
                        chunk.userData = { velocity: new THREE.Vector3((Math.random()-0.5)*5,(Math.random()-0.5)*5,(Math.random()-0.5)*5), hp:5, onFire:true, isStatic:false, frozen:false, type:'debris', burnLevel:0, lifeTime:0 };
                        scene.add(chunk); debris.push(chunk);
                    }
                    explode(k.portalPos, 50, 0xff4400);
                    scene.remove(k.portalGroup); scene.remove(k.portalLight);
                    krakens.splice(ki, 1); continue;
                }

                if (k.phase === 'open') {
                    k.portalGroup.scale.setScalar(Math.min(1, k.phaseTimer/60));
                    if (k.phaseTimer >= 60) { k.phase='emerge'; k.phaseTimer=0; }
                }

                // Tentacle state machine
                k.tentacles.forEach((tnd, ti) => {
                    tnd.stateTimer++;
                    if (tnd.state === 'hidden') {
                        tnd.chain.forEach(seg => seg.scale.set(0.001,0.001,0.001));
                        if (k.phase==='emerge' && k.phaseTimer>=tnd.emergeDelay) { tnd.state='emerging'; tnd.stateTimer=0; }
                        return;
                    }
                    if (tnd.state === 'emerging') {
                        tnd.emergeProg = Math.min(1, tnd.emergeProg+0.025);
                        const vis = tnd.emergeProg*tnd.chain.length;
                        tnd.chain.forEach((seg,si) => { const r=Math.max(0,Math.min(1,vis-si)); seg.scale.set(r,r,r); });
                        const t=k.age*0.025+tnd.noiseOff;
                        const bX = tnd.archPattern===0 ? -0.6+Math.sin(t)*0.15 : tnd.archPattern===1 ? 0.5+Math.sin(t)*0.15 : Math.sin(t*1.3)*0.4;
                        const bY = tnd.archPattern===2 ? Math.cos(t*1.1)*0.5 : 0;
                        tnd.root.rotation.x += (bX-tnd.root.rotation.x)*0.05;
                        tnd.root.rotation.y += (bY-tnd.root.rotation.y)*0.05;
                        tnd.chain.forEach((seg,si) => {
                            const d=si/tnd.chain.length, amp=0.06+d*0.18;
                            seg.rotation.x += (_tendrilNoise(t,tnd.noiseOff+si*0.9,1.1)*amp - seg.rotation.x)*0.08;
                            seg.rotation.y += (_tendrilNoise(t,tnd.noiseOff+si*1.2+40,0.85)*amp - seg.rotation.y)*0.08;
                        });
                        if (tnd.emergeProg>=1) { tnd.state='probe'; tnd.stateTimer=0; }
                        return;
                    }
                    if (tnd.state === 'probe') {
                        const t=k.age*0.03+tnd.noiseOff;
                        const bX = tnd.archPattern===0 ? -0.5+Math.sin(t)*0.3 : tnd.archPattern===1 ? 0.5+Math.sin(t)*0.25 : Math.sin(t*0.8)*0.5;
                        const bY = Math.cos(t*0.7)*0.35;
                        tnd.root.rotation.x += (bX-tnd.root.rotation.x)*0.04;
                        tnd.root.rotation.y += (bY-tnd.root.rotation.y)*0.04;
                        tnd.chain.forEach((seg,si) => {
                            const d=si/tnd.chain.length, amp=0.08+d*0.12;
                            seg.rotation.x += (_tendrilNoise(t,tnd.noiseOff+si*0.55,1.3)*amp - seg.rotation.x)*0.06;
                            seg.rotation.y += (_tendrilNoise(t,tnd.noiseOff+si*0.45+50,1.1)*amp - seg.rotation.y)*0.06;
                        });
                        if (tnd.stateTimer > 90+Math.random()*30) {
                            let best=null, bestD=Infinity;
                            worldObjects.forEach(obj => {
                                if (obj.userData.frozen||obj.userData.hp<=0||obj.userData.type==='mountain'||obj.userData.beingGrabbed) return;
                                const d=obj.position.distanceTo(k.pt);
                                if (d<80&&d<bestD) { bestD=d; best=obj; }
                            });
                            if (best) { best.userData.beingGrabbed=true; tnd.target=best; tnd.targetWorldPos=best.position.clone(); }
                            else { tnd.targetWorldPos=new THREE.Vector3(k.pt.x+(Math.random()-0.5)*80,0,k.pt.z+(Math.random()-0.5)*80); }
                            tnd.state='grab'; tnd.stateTimer=0;
                        }
                        return;
                    }
                    if (tnd.state === 'grab') {
                        const prog=Math.min(1,tnd.stateTimer/70);
                        const tw=tnd.target?tnd.target.position:tnd.targetWorldPos;
                        const bw=new THREE.Vector3(); tnd.root.getWorldPosition(bw);
                        const dir=new THREE.Vector3().subVectors(tw,bw).normalize();
                        const wl=new THREE.Quaternion().copy(k.portalGroup.quaternion).invert();
                        const ld=dir.clone().applyQuaternion(wl);
                        tnd.root.rotation.x += (-Math.atan2(ld.y,ld.z)-tnd.root.rotation.x)*0.07*prog;
                        tnd.root.rotation.y += (Math.atan2(ld.x,ld.z)-tnd.root.rotation.y)*0.07*prog;
                        tnd.chain.forEach((seg,si) => {
                            const kw=(1-prog)*0.15;
                            seg.rotation.x += (Math.sin(k.age*0.04+si)*kw - seg.rotation.x)*0.1;
                            seg.rotation.y += (Math.sin(k.age*0.04+si)*kw*0.8 - seg.rotation.y)*0.1;
                        });
                        if (prog>=1) { tnd.state='wrap'; tnd.stateTimer=0; }
                        return;
                    }
                    if (tnd.state === 'wrap') {
                        const wp=Math.min(1,tnd.stateTimer/40);
                        tnd.chain.forEach((seg,si) => {
                            const tp=Math.max(0,(si-(tnd.chain.length-6))/5);
                            const curl=tp*wp*1.5;
                            seg.rotation.x += (curl*0.5-seg.rotation.x)*0.15;
                            seg.rotation.y += (curl*0.3-seg.rotation.y)*0.15;
                        });
                        if (wp>=1) {
                            if (tnd.target) {
                                tnd.target.userData.hp-=200;
                                const toP=new THREE.Vector3().subVectors(k.portalPos,tnd.target.position).normalize();
                                tnd.target.userData.velocity.copy(toP).multiplyScalar(8);
                            }
                            tnd.state='drag'; tnd.stateTimer=0;
                        }
                        return;
                    }
                    if (tnd.state === 'drag') {
                        tnd.chain.forEach((seg,si) => {
                            const tp=Math.max(0,(si-(tnd.chain.length-6))/5);
                            seg.rotation.x += (tp*0.75+Math.sin(k.age*0.1+si)*0.05-seg.rotation.x)*0.08;
                            seg.rotation.y += (tp*0.3-seg.rotation.y)*0.08;
                        });
                        if (tnd.target&&tnd.target.userData.hp>0) {
                            const toP=new THREE.Vector3().subVectors(k.portalPos,tnd.target.position);
                            if (toP.length()>5) tnd.target.position.addScaledVector(toP.normalize(),0.3);
                            tnd.target.position.y+=0.5;
                            tnd.target.userData.hp-=5;
                        }
                        if (tnd.stateTimer>200) {
                            if (tnd.target) {
                                if (tnd.target.userData.hp<=0) { scene.remove(tnd.target); const idx=worldObjects.indexOf(tnd.target); if (idx>=0) worldObjects.splice(idx,1); }
                                else tnd.target.userData.beingGrabbed=false;
                                tnd.target=null;
                            }
                            tnd.state='probe'; tnd.stateTimer=0; tnd.grabFraction=0;
                            tnd.chain.forEach(seg => { seg.rotation.x*=0.5; seg.rotation.y*=0.5; });
                        }
                    }
                });

                // Phase transitions
                if (k.phase==='emerge') {
                    const allOut=k.tentacles.every(t=>t.emergeProg>=1||t.state!=='hidden');
                    if (allOut&&k.phaseTimer>200) { k.phase='attack'; k.phaseTimer=0; }
                }

                if (k.phase==='attack' && k.age>=k.lifeMax*0.62) {
                    k.phase='groundGrab'; k.phaseTimer=0;
                    k.tentacles.forEach(t => { if (t.target) { t.target.userData.beingGrabbed=false; t.target=null; } });
                    // Build ground chunk
                    const CR=45, cc=k.pt.clone(); cc.y=0;
                    const cg=new THREE.Group(); cg.position.copy(cc); scene.add(cg);
                    const top=new THREE.Mesh(new THREE.CylinderGeometry(CR,CR*0.92,1.6,32),new THREE.MeshStandardMaterial({color:0x4a7c2a,roughness:0.95}));
                    top.position.y=0.8; top.castShadow=true; cg.add(top);
                    const em=new THREE.MeshStandardMaterial({color:0x3a2410,roughness:1});
                    const earth=new THREE.Mesh(new THREE.CylinderGeometry(CR*0.92,CR*0.5,14,24),em);
                    earth.position.y=-7; cg.add(earth);
                    for (let r=0;r<18;r++) {
                        const a=(r/18)*Math.PI*2, rr=CR*(0.6+Math.random()*0.4);
                        const stub=new THREE.Mesh(new THREE.ConeGeometry(2+Math.random()*3,6+Math.random()*8,6),em);
                        stub.position.set(Math.cos(a)*rr,-10-Math.random()*5,Math.sin(a)*rr);
                        stub.rotation.x=Math.PI; cg.add(stub);
                    }
                    const grabbed=[], remaining=[];
                    worldObjects.forEach(obj => {
                        const dx=obj.position.x-cc.x, dz=obj.position.z-cc.z;
                        if (Math.sqrt(dx*dx+dz*dz)<CR&&!obj.userData.frozen) {
                            scene.remove(obj); obj.position.x-=cc.x; obj.position.z-=cc.z; obj.position.y+=1.6;
                            cg.add(obj); obj.userData.beingGrabbed=true; obj.userData.frozen=true; grabbed.push(obj);
                        } else remaining.push(obj);
                    });
                    worldObjects=remaining;
                    k.groundChunk={group:cg,objects:grabbed,center:cc,radius:CR,rotSpeed:0.005+Math.random()*0.01};
                    explode(cc,50,0x8a5a2a); shatter(cc,20,0x3a2410,2);
                }

                if (k.phase==='groundGrab') {
                    const chunk=k.groundChunk;
                    if (!chunk) { k.phase='withdraw'; k.phaseTimer=0; }
                    else {
                        k.tentacles.forEach((tnd,ti) => {
                            const aa=(ti/k.tentacles.length)*Math.PI*2;
                            const aw=new THREE.Vector3(chunk.group.position.x+Math.cos(aa)*chunk.radius*0.9,chunk.group.position.y+1.5,chunk.group.position.z+Math.sin(aa)*chunk.radius*0.9);
                            const bw=new THREE.Vector3(); tnd.root.getWorldPosition(bw);
                            const dA=new THREE.Vector3().subVectors(aw,bw).normalize();
                            const wl=new THREE.Quaternion().copy(k.portalGroup.quaternion).invert();
                            const ld=dA.clone().applyQuaternion(wl);
                            tnd.root.rotation.x+=(-Math.atan2(ld.y,ld.z)-tnd.root.rotation.x)*0.08;
                            tnd.root.rotation.y+=(Math.atan2(ld.x,ld.z)-tnd.root.rotation.y)*0.08;
                            tnd.chain.forEach((seg,si) => {
                                const tp=Math.max(0,(si-(tnd.chain.length-6))/5);
                                seg.rotation.x+=(tp*0.78+Math.sin(k.age*0.1+si+ti)*0.04-seg.rotation.x)*0.1;
                                seg.rotation.y+=(tp*0.2-seg.rotation.y)*0.1;
                            });
                        });
                        if (k.phaseTimer<40) {
                            chunk.group.position.x=chunk.center.x+(Math.random()-0.5)*1.5;
                            chunk.group.position.z=chunk.center.z+(Math.random()-0.5)*1.5;
                            chunk.group.position.y=(Math.random()-0.5)*0.8;
                            if (k.phaseTimer%4===0) for (let s=0;s<4;s++) createFireParticle(new THREE.Vector3(chunk.center.x+(Math.random()-0.5)*chunk.radius*1.8,Math.random()*3,chunk.center.z+(Math.random()-0.5)*chunk.radius*1.8),true);
                        } else {
                            const lp=Math.min(1,(k.phaseTimer-40)/110);
                            const ez=lp*lp*(3-2*lp);
                            chunk.group.position.lerpVectors(chunk.center,k.portalPos,ez);
                            chunk.group.rotation.y+=chunk.rotSpeed;
                            chunk.group.rotation.x+=chunk.rotSpeed*0.4;
                            if (lp>0.7) chunk.group.scale.setScalar(1-(lp-0.7)/0.3*0.6);
                        }
                        if (k.phaseTimer>=150) {
                            explode(k.portalPos,70,0xff5500);
                            chunk.objects.forEach(o => { o.userData.beingGrabbed=false; });
                            scene.remove(chunk.group); k.groundChunk=null;
                            k.phase='withdraw'; k.phaseTimer=0;
                        }
                    }
                }

                if (k.phase==='withdraw') {
                    k.tentacles.forEach(t => {
                        t.emergeProg=Math.max(0,t.emergeProg-0.012);
                        const vis=t.emergeProg*t.chain.length;
                        t.chain.forEach((seg,si) => { const r=Math.max(0,Math.min(1,vis-si)); seg.scale.set(r,r,r); seg.rotation.x*=0.92; seg.rotation.y*=0.92; });
                    });
                    if (k.phaseTimer>90) { k.phase='close'; k.phaseTimer=0; }
                }

                if (k.phase==='close') {
                    k.portalGroup.scale.setScalar(Math.max(0,1-k.phaseTimer/60));
                    k.portalLight.intensity*=0.95;
                    if (k.phaseTimer>=60) { scene.remove(k.portalGroup); scene.remove(k.portalLight); krakens.splice(ki,1); }
                }
            }
        }

        function spawnLavaBomb(volcanoPt, ventY) {
            const bomb = new THREE.Mesh(
                new THREE.SphereGeometry(0.7 + Math.random() * 0.6, 8, 6),
                new THREE.MeshStandardMaterial({
                    color: 0xff7700,
                    emissive: 0xff4400,
                    emissiveIntensity: 1.5
                })
            );
            bomb.position.set(
                volcanoPt.x + (Math.random() - 0.5) * 2,
                ventY + 1,
                volcanoPt.z + (Math.random() - 0.5) * 2
            );
            // Shoot up and outward in random direction
            const angle = Math.random() * Math.PI * 2;
            const horizontalSpeed = 0.6 + Math.random() * 0.8;
            bomb.userData = {
                vel: new THREE.Vector3(
                    Math.cos(angle) * horizontalSpeed,
                    1.2 + Math.random() * 0.8,
                    Math.sin(angle) * horizontalSpeed
                ),
                life: 1.0
            };
            scene.add(bomb);
            lavaBombs.push(bomb);
        }

        // Builder firebomb — small flaming projectile thrown at a target
        function spawnFirebomb(fromPos, toPos) {
            const bomb = new THREE.Mesh(
                new THREE.SphereGeometry(0.5, 7, 5),
                new THREE.MeshStandardMaterial({
                    color: 0xff8822,
                    emissive: 0xff4400,
                    emissiveIntensity: 1.8
                })
            );
            bomb.position.copy(fromPos);
            // Compute a parabolic launch velocity. Solve for time to reach target horizontally,
            // then back-solve required vertical velocity given gravity.
            const dx = toPos.x - fromPos.x;
            const dz = toPos.z - fromPos.z;
            const horizontalDist = Math.sqrt(dx*dx + dz*dz);
            const horizontalSpeed = 1.0; // per frame
            const t = Math.max(20, horizontalDist / horizontalSpeed);
            const gravity = 0.04;
            // y(t) = y0 + vy*t - 0.5*g*t^2 = toPos.y  →  vy = (toPos.y - fromPos.y + 0.5*g*t^2) / t
            const vy = (toPos.y - fromPos.y + 0.5 * gravity * t * t) / t;
            bomb.userData = {
                vel: new THREE.Vector3(dx / t, vy, dz / t),
                life: 1.0,
                gravity: gravity,
                isFirebomb: true
            };
            scene.add(bomb);
            lavaBombs.push(bomb);
        }

        // Crossbow bolt (invader projectile)
        let crossbowBolts = [];
        function spawnCrossbowBolt(fromPos, toPos, flaming) {
            const bolt = new THREE.Group();
            // Shaft
            const shaft = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.06, 1.2, 6),
                new THREE.MeshStandardMaterial({ color: 0x6b3a1a, roughness: 0.95 })
            );
            shaft.rotation.z = Math.PI / 2;
            bolt.add(shaft);
            // Tip
            const tip = new THREE.Mesh(
                new THREE.ConeGeometry(0.1, 0.3, 5),
                new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.6 })
            );
            tip.rotation.z = -Math.PI / 2;
            tip.position.x = 0.7;
            bolt.add(tip);
            // Fletching
            for (let i = 0; i < 3; i++) {
                const f = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3, 0.18, 0.04),
                    new THREE.MeshStandardMaterial({ color: 0xcc4422 })
                );
                f.position.x = -0.55;
                f.rotation.x = (i / 3) * Math.PI * 2;
                bolt.add(f);
            }
            // Flame trail if flaming
            if (flaming) {
                const flame = new THREE.Mesh(
                    new THREE.SphereGeometry(0.4, 6, 5),
                    new THREE.MeshBasicMaterial({ color: 0xff7700, transparent: true, opacity: 0.9 })
                );
                flame.position.x = 0.4;
                bolt.add(flame);
                bolt.userData.flame = flame;
            }
            bolt.position.copy(fromPos);

            // Trajectory: regular bolts shoot STRAIGHT (no gravity, no arc).
            // Flaming bolts use a slight arc so they look thrown rather than shot.
            const dx = toPos.x - fromPos.x;
            const dy = toPos.y - fromPos.y;
            const dz = toPos.z - fromPos.z;
            const horizDist = Math.sqrt(dx*dx + dz*dz);

            if (flaming) {
                // Lobbed: parabolic arc
                const flightTime = Math.max(10, horizDist / 1.2);
                const grav = 0.025;
                const vy = (dy + 0.5 * grav * flightTime * flightTime) / flightTime;
                bolt.userData.vel = new THREE.Vector3(dx / flightTime, vy, dz / flightTime);
                bolt.userData.gravity = grav;
            } else {
                // Straight shot: full 3D direction normalized to high speed, no gravity
                const dist3 = Math.sqrt(dx*dx + dy*dy + dz*dz);
                const speed = 2.0; // fast straight bolt
                bolt.userData.vel = new THREE.Vector3(dx / dist3, dy / dist3, dz / dist3).multiplyScalar(speed);
                bolt.userData.gravity = 0;
            }
            bolt.userData.flaming = flaming;
            bolt.userData.life = 1.0;
            bolt.userData.age = 0;
            // Aim the bolt model along its velocity direction
            bolt.lookAt(bolt.position.clone().add(bolt.userData.vel));
            scene.add(bolt);
            crossbowBolts.push(bolt);
        }

        function despawnVolcano(v) {
            scene.remove(v.mesh);
            v.mesh.traverse(c => {
                if (c.isMesh) {
                    c.geometry.dispose();
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material.dispose();
                }
            });
            // Clean up smoke particles
            if (v.smokeParticles) {
                v.smokeParticles.forEach(sm => {
                    scene.remove(sm);
                    if (sm.geometry) sm.geometry.dispose();
                    if (sm.material) sm.material.dispose();
                });
                v.smokeParticles.length = 0;
            }
        }

        function despawnAllVolcanoes() {
            volcanoes.forEach(despawnVolcano);
            volcanoes = [];
            lavaBombs.forEach(b => scene.remove(b));
            lavaBombs = [];
        }

        // ===== CYCLOPS: stomping monster =====
        function spawnCyclops(pt) {
            const group = new THREE.Group();
            // SCALE: massive — roughly 2.5x previous size (now ~55 units tall)
            const SCALE = 2.5;

            const skinMat = new THREE.MeshStandardMaterial({ color: 0x556b3d, roughness: 0.9 });
            const skinDark = new THREE.MeshStandardMaterial({ color: 0x394928, roughness: 0.95 });
            const darkMat = new THREE.MeshStandardMaterial({ color: 0x2d3a1f, roughness: 0.95 });
            const scleraMat = new THREE.MeshStandardMaterial({
                color: 0xfaf8e8,
                roughness: 0.4,
                emissive: 0xfff5d0,
                emissiveIntensity: 0.15
            });
            const irisMat = new THREE.MeshStandardMaterial({
                color: 0xff2200,
                emissive: 0xff0000,
                emissiveIntensity: 1.8,
                roughness: 0.2
            });
            const pupilMat = new THREE.MeshStandardMaterial({
                color: 0x000000,
                emissive: 0x000000,
                roughness: 1
            });

            // Pelvis
            const pelvis = new THREE.Mesh(
                new THREE.BoxGeometry(8 * SCALE, 4 * SCALE, 6 * SCALE),
                skinDark
            );
            pelvis.position.y = 16 * SCALE;
            pelvis.castShadow = true;
            group.add(pelvis);

            // Torso — broad and barrel-chested
            const torso = new THREE.Mesh(
                new THREE.CylinderGeometry(5.5 * SCALE, 6 * SCALE, 9 * SCALE, 12),
                skinMat
            );
            torso.position.y = 22 * SCALE;
            torso.castShadow = true;
            group.add(torso);
            // Pectoral bumps
            const pecMat = skinMat;
            for (const xs of [-2.5, 2.5]) {
                const pec = new THREE.Mesh(
                    new THREE.SphereGeometry(2.5 * SCALE, 8, 6),
                    pecMat
                );
                pec.position.set(xs * SCALE, 24 * SCALE, 4 * SCALE);
                pec.castShadow = true;
                group.add(pec);
            }
            // Belly
            const belly = new THREE.Mesh(
                new THREE.SphereGeometry(5 * SCALE, 10, 8),
                skinMat
            );
            belly.position.set(0, 19 * SCALE, 3 * SCALE);
            belly.scale.set(1, 0.7, 0.6);
            group.add(belly);

            // Neck (short and thick)
            const neck = new THREE.Mesh(
                new THREE.CylinderGeometry(2.8 * SCALE, 3.5 * SCALE, 2 * SCALE, 8),
                skinMat
            );
            neck.position.y = 27.5 * SCALE;
            group.add(neck);

            // Head — large, slightly elongated downward (jaw)
            const head = new THREE.Mesh(
                new THREE.SphereGeometry(5 * SCALE, 14, 12),
                skinMat
            );
            head.position.y = 32 * SCALE;
            head.scale.set(1, 1.05, 1.1);
            head.castShadow = true;
            group.add(head);

            // Jaw
            const jaw = new THREE.Mesh(
                new THREE.BoxGeometry(7 * SCALE, 2.5 * SCALE, 5 * SCALE),
                skinDark
            );
            jaw.position.set(0, 28.5 * SCALE, 1.5 * SCALE);
            jaw.castShadow = true;
            group.add(jaw);

            // Teeth (suggest a snarl)
            const teethMat = new THREE.MeshStandardMaterial({ color: 0xeed8a0, roughness: 0.5 });
            for (let i = 0; i < 5; i++) {
                const tooth = new THREE.Mesh(
                    new THREE.ConeGeometry(0.3 * SCALE, 0.8 * SCALE, 4),
                    teethMat
                );
                tooth.position.set((i - 2) * 0.7 * SCALE, 29.4 * SCALE, 4 * SCALE);
                tooth.rotation.x = Math.PI;
                group.add(tooth);
            }

            // Brow ridge — large and menacing
            const brow = new THREE.Mesh(
                new THREE.BoxGeometry(8 * SCALE, 1.4 * SCALE, 1.4 * SCALE),
                skinDark
            );
            brow.position.set(0, 34 * SCALE, 4 * SCALE);
            brow.rotation.x = -0.25;
            brow.castShadow = true;
            group.add(brow);

            // Eye socket: a recessed darker sphere
            const socket = new THREE.Mesh(
                new THREE.SphereGeometry(2.5 * SCALE, 12, 10),
                darkMat
            );
            socket.position.set(0, 32.5 * SCALE, 4 * SCALE);
            socket.scale.set(1, 0.95, 0.7);
            group.add(socket);

            // === EYE ANATOMY (tracks target) ===
            // Eyeball pivot — we'll rotate this group to aim the eye
            const eyePivot = new THREE.Group();
            eyePivot.position.set(0, 32.5 * SCALE, 4 * SCALE);
            group.add(eyePivot);
            // Sclera (white of eye)
            const sclera = new THREE.Mesh(
                new THREE.SphereGeometry(2.0 * SCALE, 16, 14),
                scleraMat
            );
            eyePivot.add(sclera);
            // Iris (red glowing) on the front of the eyeball
            const iris = new THREE.Mesh(
                new THREE.SphereGeometry(0.95 * SCALE, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2.5),
                irisMat
            );
            iris.rotation.x = Math.PI / 2;
            iris.position.z = 1.15 * SCALE;
            eyePivot.add(iris);
            // Pupil (black) center of iris
            const pupil = new THREE.Mesh(
                new THREE.SphereGeometry(0.4 * SCALE, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2.5),
                pupilMat
            );
            pupil.rotation.x = Math.PI / 2;
            pupil.position.z = 1.95 * SCALE;
            eyePivot.add(pupil);

            // Eye glow point light
            const eyeLight = new THREE.PointLight(0xff3300, 2, 60 * SCALE);
            eyeLight.position.set(0, 32.5 * SCALE, 6 * SCALE);
            group.add(eyeLight);

            // Wild hair tufts (small dark spheres on top of head)
            for (let i = 0; i < 6; i++) {
                const tuft = new THREE.Mesh(
                    new THREE.SphereGeometry((0.6 + Math.random() * 0.4) * SCALE, 6, 5),
                    darkMat
                );
                const ang = Math.random() * Math.PI * 2;
                const dist = Math.random() * 2 * SCALE;
                tuft.position.set(
                    Math.cos(ang) * dist,
                    36 * SCALE + Math.random() * 1.5 * SCALE,
                    Math.sin(ang) * dist - 1 * SCALE
                );
                group.add(tuft);
            }

            // Beard (short scruff under jaw)
            for (let i = 0; i < 8; i++) {
                const beard = new THREE.Mesh(
                    new THREE.SphereGeometry((0.4 + Math.random() * 0.3) * SCALE, 5, 4),
                    darkMat
                );
                const ang = (i / 8) * Math.PI;
                beard.position.set(
                    Math.cos(ang) * 3 * SCALE,
                    27 * SCALE,
                    Math.sin(ang) * 1 * SCALE + 2 * SCALE
                );
                group.add(beard);
            }

            // === ARMS with pivot for shoulder rotation ===
            function makeArm(side) {
                const armGroup = new THREE.Group();
                armGroup.position.set(side * 6.5 * SCALE, 25 * SCALE, 0);
                // Upper arm (bicep)
                const upper = new THREE.Mesh(
                    new THREE.CylinderGeometry(1.6 * SCALE, 1.9 * SCALE, 7 * SCALE, 8),
                    skinMat
                );
                upper.position.y = -3.5 * SCALE;
                upper.castShadow = true;
                armGroup.add(upper);
                // Elbow joint
                const elbow = new THREE.Mesh(
                    new THREE.SphereGeometry(1.7 * SCALE, 8, 6),
                    skinDark
                );
                elbow.position.y = -7 * SCALE;
                armGroup.add(elbow);
                // Forearm
                const forearm = new THREE.Mesh(
                    new THREE.CylinderGeometry(1.4 * SCALE, 1.7 * SCALE, 6.5 * SCALE, 8),
                    skinMat
                );
                forearm.position.y = -10.2 * SCALE;
                forearm.castShadow = true;
                armGroup.add(forearm);
                // Fist
                const fist = new THREE.Mesh(
                    new THREE.SphereGeometry(2.2 * SCALE, 8, 6),
                    skinDark
                );
                fist.position.y = -13.8 * SCALE;
                fist.castShadow = true;
                armGroup.add(fist);
                group.add(armGroup);
                return { armGroup, fist };
            }
            const armLObj = makeArm(-1);
            const armRObj = makeArm(1);

            // Club gripped by right fist
            const clubMat = new THREE.MeshStandardMaterial({ color: 0x4a2c12, roughness: 1 });
            const clubGroup = new THREE.Group();
            // The club hangs from the right fist
            const clubShaft = new THREE.Mesh(
                new THREE.CylinderGeometry(0.7 * SCALE, 1.8 * SCALE, 14 * SCALE, 8),
                clubMat
            );
            clubShaft.position.y = -7 * SCALE;
            clubShaft.castShadow = true;
            clubGroup.add(clubShaft);
            // Club head bumps
            for (let i = 0; i < 6; i++) {
                const bump = new THREE.Mesh(
                    new THREE.SphereGeometry((0.7 + Math.random() * 0.4) * SCALE, 6, 4),
                    clubMat
                );
                const ang = (i / 6) * Math.PI * 2;
                bump.position.set(Math.cos(ang) * 1.4 * SCALE, -13 * SCALE + Math.random() * 1 * SCALE, Math.sin(ang) * 1.4 * SCALE);
                clubGroup.add(bump);
            }
            // Attach to right arm at fist position
            armRObj.armGroup.add(clubGroup);
            clubGroup.position.y = -13 * SCALE; // start at fist

            // === LEGS with pivot at hip for proper walk ===
            function makeLeg(side) {
                const legGroup = new THREE.Group();
                legGroup.position.set(side * 2.8 * SCALE, 15 * SCALE, 0);
                // Thigh
                const thigh = new THREE.Mesh(
                    new THREE.CylinderGeometry(2.2 * SCALE, 2.6 * SCALE, 7 * SCALE, 8),
                    skinMat
                );
                thigh.position.y = -3.5 * SCALE;
                thigh.castShadow = true;
                legGroup.add(thigh);
                // Knee
                const knee = new THREE.Mesh(
                    new THREE.SphereGeometry(2.4 * SCALE, 8, 6),
                    skinDark
                );
                knee.position.y = -7 * SCALE;
                legGroup.add(knee);
                // Shin
                const shin = new THREE.Mesh(
                    new THREE.CylinderGeometry(1.8 * SCALE, 2.2 * SCALE, 6.5 * SCALE, 8),
                    skinMat
                );
                shin.position.y = -10.3 * SCALE;
                shin.castShadow = true;
                legGroup.add(shin);
                // Foot (large flat slab)
                const foot = new THREE.Mesh(
                    new THREE.BoxGeometry(3 * SCALE, 1.2 * SCALE, 4.5 * SCALE),
                    darkMat
                );
                foot.position.set(0, -14 * SCALE, 0.5 * SCALE);
                foot.castShadow = true;
                legGroup.add(foot);
                // Toe nubs
                for (let t = 0; t < 4; t++) {
                    const toe = new THREE.Mesh(
                        new THREE.SphereGeometry(0.6 * SCALE, 6, 5),
                        darkMat
                    );
                    toe.position.set((t - 1.5) * 0.7 * SCALE, -14.4 * SCALE, 2.5 * SCALE);
                    legGroup.add(toe);
                }
                group.add(legGroup);
                return { legGroup, foot };
            }
            const legLObj = makeLeg(-1);
            const legRObj = makeLeg(1);

            group.position.set(pt.x, 0, pt.z);
            scene.add(group);

            cyclopses.push({
                mesh: group,
                age: 0,
                speed: 0.22, // slow lumbering
                target: null,
                state: 'walking',
                stateTimer: 0,
                walkPhase: 0,
                hp: 1500,
                maxHp: 1500,
                onFire: false,
                burnLevel: 0,
                deathTimer: 0,
                deathAxis: null,
                eyePivot: eyePivot,
                eyeLight: eyeLight,
                iris: iris,
                pupil: pupil,
                clubGroup: clubGroup,
                armL: armLObj.armGroup,
                armR: armRObj.armGroup,
                fistL: armLObj.fist,
                fistR: armRObj.fist,
                legL: legLObj.legGroup,
                legR: legRObj.legGroup,
                footL: legLObj.foot,
                footR: legRObj.foot,
                head: head,
                jaw: jaw,
                scale: SCALE
            });
        }

        function despawnCyclops(c) {
            scene.remove(c.mesh);
            c.mesh.traverse(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                    else child.material.dispose();
                }
            });
        }

        function despawnAllCyclopses() {
            cyclopses.forEach(despawnCyclops);
            cyclopses = [];
        }

        // Crush anything under the foot's world position. radius defaults to 2.5.
        function crushUnderFoot(footPos, radius = 2.5) {
            worldObjects.forEach(o => {
                if (o.userData.frozen) return;
                if (o.userData.type === 'road') return;
                const dx = o.position.x - footPos.x;
                const dz = o.position.z - footPos.z;
                const distXZ = Math.sqrt(dx*dx + dz*dz);
                if (distXZ < radius) {
                    // Stomped
                    if (o.userData.type === 'human' || o.userData.type === 'builder') {
                        o.userData.hp = 0;
                    } else if (o.userData.type === 'tree') {
                        if (!o.userData.isFalling && !o.userData.hasFallen) {
                            o.userData.isFalling = true;
                            o.userData.fallAxis = new THREE.Vector3(dx, 0, dz).normalize();
                            o.userData.fallAngle = 0;
                            o.userData.hp = 9999;
                        }
                    } else if (o.userData.type === 'house' || o.userData.type === 'rubble') {
                        o.userData.hp -= 100;
                    }
                }
            });
        }

        // Find the nearest "interesting" target for a cyclops to attack
        function findCyclopsTarget(c) {
            let best = null, bestD = Infinity;
            worldObjects.forEach(o => {
                if (o.userData.frozen) return; // ignore corpses
                if (o.userData.type === 'road') return;
                if (o.userData.hp <= 0) return;
                const d = o.position.distanceTo(c.mesh.position);
                if (d < bestD && d > 1) {
                    bestD = d;
                    best = o;
                }
            });
            return best;
        }

        // ===== RIVERS =====
        let rivers = []; // array of meshes
        let isDrawingRiver = false;
        let riverPath = []; // array of THREE.Vector3 points
        let riverPreview = null;

        function buildRiverFromPath(path) {
            if (path.length < 2) return null;

            // Build a flat ribbon along the path. We'll make a flat plane mesh
            // by manually creating geometry from segments.
            const positions = [];
            const indices = [];
            const uvs = [];
            const width = 4; // half-width of river

            for (let i = 0; i < path.length; i++) {
                const p = path[i];
                // Compute perpendicular direction
                let dir;
                if (i === 0) {
                    dir = new THREE.Vector3().subVectors(path[1], path[0]).normalize();
                } else if (i === path.length - 1) {
                    dir = new THREE.Vector3().subVectors(path[i], path[i-1]).normalize();
                } else {
                    const a = new THREE.Vector3().subVectors(path[i], path[i-1]).normalize();
                    const b = new THREE.Vector3().subVectors(path[i+1], path[i]).normalize();
                    dir = a.add(b).normalize();
                }
                const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
                const left = p.clone().add(perp.clone().multiplyScalar(width));
                const right = p.clone().add(perp.clone().multiplyScalar(-width));
                positions.push(left.x, 0.18, left.z);
                positions.push(right.x, 0.18, right.z);
                uvs.push(0, i / (path.length - 1));
                uvs.push(1, i / (path.length - 1));
                if (i < path.length - 1) {
                    const a = i * 2;
                    indices.push(a, a + 1, a + 2);
                    indices.push(a + 1, a + 3, a + 2);
                }
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geo.setIndex(indices);
            geo.computeVertexNormals();

            const mat = new THREE.MeshStandardMaterial({
                color: 0x1e6091,
                emissive: 0x0a3a5c,
                emissiveIntensity: 0.2,
                roughness: 0.3,
                metalness: 0.6,
                transparent: true,
                opacity: 0.92,
                side: THREE.DoubleSide
            });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.receiveShadow = true;
            return mesh;
        }

        function commitRiverPath() {
            if (riverPath.length < 2) {
                riverPath = [];
                if (riverPreview) {
                    scene.remove(riverPreview);
                    riverPreview = null;
                }
                return;
            }
            const river = buildRiverFromPath(riverPath);
            if (river) {
                scene.add(river);
                rivers.push(river);
            }
            if (riverPreview) {
                scene.remove(riverPreview);
                riverPreview = null;
            }
            riverPath = [];
        }

        function clearRivers() {
            rivers.forEach(r => {
                scene.remove(r);
                r.geometry.dispose();
                r.material.dispose();
            });
            rivers = [];
        }

        // ===== TERRAIN GENERATOR =====
        // Generate a complete village layout: cluster of houses, residents, trees, and a few mountains around
        function generateRandomVillage() {
            // Clear existing objects
            worldObjects.forEach(o => scene.remove(o));
            worldObjects = [];
            debris.forEach(d => scene.remove(d));
            debris = [];
            fireParticles.forEach(f => scene.remove(f));
            fireParticles = [];
            lavaBombs.forEach(b => scene.remove(b));
            lavaBombs = [];
            crossbowBolts.forEach(b => scene.remove(b));
            crossbowBolts = [];
            lavaStreams.forEach(ls => {
                if (ls.pool) scene.remove(ls.pool);
                if (ls.stream) scene.remove(ls.stream);
                if (ls.glow) scene.remove(ls.glow);
                if (ls.drops) ls.drops.forEach(d => scene.remove(d));
            });
            lavaStreams = [];
            cooledLavaPools.forEach(p => { scene.remove(p); if (p.geometry) p.geometry.dispose(); if (p.material) p.material.dispose(); });
            cooledLavaPools = [];
            despawnAllTornadoes();
            despawnAllTsunamis();
            despawnAllVolcanoes();
            despawnAllCyclopses();
            clearRivers();
            singularityPoint = null;

            // Layout: village center at origin, houses arranged in concentric rings
            const houseCount = 12 + Math.floor(Math.random() * 8); // 12-19 houses
            // Place village square at center first
            const placed = [];
            // Inner ring of 6 houses around the center
            for (let i = 0; i < 6; i++) {
                const ang = (i / 6) * Math.PI * 2 + Math.random() * 0.2;
                const r = 14 + Math.random() * 4;
                const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                placeObject('house', pos);
                placed.push(pos);
            }
            // Outer ring
            const outerCount = houseCount - 6;
            for (let i = 0; i < outerCount; i++) {
                let attempts = 0;
                while (attempts++ < 12) {
                    const ang = Math.random() * Math.PI * 2;
                    const r = 28 + Math.random() * 18;
                    const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                    // Don't place on top of another
                    let collides = false;
                    for (const p of placed) {
                        if (p.distanceTo(pos) < 11) { collides = true; break; }
                    }
                    if (collides) continue;
                    placeObject('house', pos);
                    placed.push(pos);
                    break;
                }
            }

            // 2-4 skyscrapers in the town center — always spawned
            const towers = 2 + Math.floor(Math.random() * 3);
            for (let i = 0; i < towers; i++) {
                let attempts = 0;
                while (attempts++ < 15) {
                    const ang = Math.random() * Math.PI * 2;
                    const r = 5 + Math.random() * 10;
                    const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                    let collides = false;
                    for (const p of placed) {
                        if (p.distanceTo(pos) < 14) { collides = true; break; }
                    }
                    if (collides) continue;
                    placeObject('skyscraper', pos);
                    placed.push(pos.clone());
                    break;
                }
            }

            // Trees scattered between houses, more dense at the outskirts
            const treeCount = 25 + Math.floor(Math.random() * 20);
            for (let i = 0; i < treeCount; i++) {
                const ang = Math.random() * Math.PI * 2;
                // Trees prefer the outer edges
                const r = 35 + Math.random() * (WORLD_SIZE - 50);
                const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                let collides = false;
                for (const p of placed) {
                    if (p.distanceTo(pos) < 5) { collides = true; break; }
                }
                if (collides) continue;
                placeObject('tree', pos);
            }

            // A few mountains around the perimeter
            const mountainCount = 3 + Math.floor(Math.random() * 3);
            for (let i = 0; i < mountainCount; i++) {
                const ang = (i / mountainCount) * Math.PI * 2 + Math.random() * 0.6;
                const r = WORLD_SIZE * 0.85;
                const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                placeObject('mountain', pos);
            }

            // Animals — a couple wandering nearby
            const animalCount = 4 + Math.floor(Math.random() * 4);
            for (let i = 0; i < animalCount; i++) {
                const ang = Math.random() * Math.PI * 2;
                const r = 30 + Math.random() * 80;
                const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                placeObject('animal', pos);
            }

            // A couple of builders near the village
            for (let i = 0; i < 2; i++) {
                const ang = Math.random() * Math.PI * 2;
                const r = 20 + Math.random() * 8;
                const pos = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
                placeObject('builder', pos);
            }

            // Initial residents will spawn over time via auto-spawner
            spawnGrass();
            showMessage(`Village built: ${houseCount} houses · ${mountainCount} mountains`);
        }

        function generateTerrain() {
            // Clear existing world
            worldObjects.forEach(o => scene.remove(o));
            worldObjects = [];
            debris.forEach(d => scene.remove(d));
            debris = [];
            fireParticles.forEach(f => scene.remove(f));
            fireParticles = [];
            lavaBombs.forEach(b => scene.remove(b));
            lavaBombs = [];
            crossbowBolts.forEach(b => scene.remove(b));
            crossbowBolts = [];
            lavaStreams.forEach(ls => {
                if (ls.pool) scene.remove(ls.pool);
                if (ls.stream) scene.remove(ls.stream);
                if (ls.glow) scene.remove(ls.glow);
                if (ls.drops) ls.drops.forEach(d => scene.remove(d));
            });
            lavaStreams = [];
            cooledLavaPools.forEach(p => { scene.remove(p); if (p.geometry) p.geometry.dispose(); if (p.material) p.material.dispose(); });
            cooledLavaPools = [];
            despawnAllTornadoes();
            despawnAllTsunamis();
            despawnAllVolcanoes();
            despawnAllCyclopses();
            clearRivers();
            singularityPoint = null;

            // Maybe generate a river (50% chance)
            const hasRiver = Math.random() < 0.5;
            let riverPathGen = null;
            if (hasRiver) {
                // Generate a wandering river across the map
                const startAngle = Math.random() * Math.PI * 2;
                const endAngle = startAngle + Math.PI + (Math.random() - 0.5) * 0.5;
                const start = new THREE.Vector3(
                    Math.cos(startAngle) * (WORLD_SIZE - 5),
                    0,
                    Math.sin(startAngle) * (WORLD_SIZE - 5)
                );
                const end = new THREE.Vector3(
                    Math.cos(endAngle) * (WORLD_SIZE - 5),
                    0,
                    Math.sin(endAngle) * (WORLD_SIZE - 5)
                );
                // Subdivide with random perpendicular offsets for meandering
                riverPathGen = [start];
                const segments = 8;
                for (let i = 1; i < segments; i++) {
                    const t = i / segments;
                    const base = new THREE.Vector3().lerpVectors(start, end, t);
                    const tangent = new THREE.Vector3().subVectors(end, start).normalize();
                    const perp = new THREE.Vector3(-tangent.z, 0, tangent.x);
                    const offset = Math.sin(t * Math.PI * 2 + Math.random()) * 25 + (Math.random() - 0.5) * 15;
                    base.add(perp.multiplyScalar(offset));
                    riverPathGen.push(base);
                }
                riverPathGen.push(end);
                const r = buildRiverFromPath(riverPathGen);
                if (r) {
                    scene.add(r);
                    rivers.push(r);
                }
            }

            // Helper: avoid placing inside river
            function tooCloseToRiver(pos) {
                if (!riverPathGen) return false;
                for (let i = 0; i < riverPathGen.length - 1; i++) {
                    const a = riverPathGen[i], b = riverPathGen[i+1];
                    // Distance from pos to segment ab
                    const ab = new THREE.Vector3().subVectors(b, a);
                    const ap = new THREE.Vector3().subVectors(pos, a);
                    const t = Math.max(0, Math.min(1, ap.dot(ab) / ab.dot(ab)));
                    const closest = a.clone().add(ab.multiplyScalar(t));
                    if (closest.distanceTo(pos) < 8) return true;
                }
                return false;
            }

            // Track placed mountain footprints so trees don't spawn on them
            const mountainFootprints = [];

            // Mountain pattern selection: range, scattered, ring, or none
            const mountainPattern = Math.random();
            let mountainCount = 0;
            if (mountainPattern < 0.25) {
                // No mountains
                mountainCount = 0;
            } else if (mountainPattern < 0.55) {
                // Scattered: 2-4 standalone peaks
                mountainCount = 2 + Math.floor(Math.random() * 3);
                for (let i = 0; i < mountainCount; i++) {
                    let attempts = 0;
                    while (attempts++ < 12) {
                        const angle = Math.random() * Math.PI * 2;
                        const dist = WORLD_SIZE * (0.5 + Math.random() * 0.4);
                        const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
                        if (tooCloseToRiver(pos)) continue;
                        // Don't overlap existing mountains
                        const collides = mountainFootprints.some(f => f.pos.distanceTo(pos) < f.radius + 30);
                        if (collides) continue;
                        placeObject('mountain', pos);
                        const justPlaced = worldObjects[worldObjects.length - 1];
                        mountainFootprints.push({ pos: pos.clone(), radius: justPlaced.userData.footprint / 2 });
                        break;
                    }
                }
            } else if (mountainPattern < 0.8) {
                // Range: 3-6 mountains in a line along one edge of the world
                mountainCount = 3 + Math.floor(Math.random() * 4);
                const rangeAngle = Math.random() * Math.PI * 2;
                const rangePerp = new THREE.Vector3(-Math.sin(rangeAngle), 0, Math.cos(rangeAngle));
                const baseDist = WORLD_SIZE * 0.7;
                const baseCenter = new THREE.Vector3(Math.cos(rangeAngle) * baseDist, 0, Math.sin(rangeAngle) * baseDist);
                const rangeLength = WORLD_SIZE * 1.4;
                for (let i = 0; i < mountainCount; i++) {
                    const t = (i / (mountainCount - 1) - 0.5);
                    const offset = rangePerp.clone().multiplyScalar(t * rangeLength);
                    const wobble = new THREE.Vector3(
                        (Math.random() - 0.5) * 18,
                        0,
                        (Math.random() - 0.5) * 18
                    );
                    const pos = baseCenter.clone().add(offset).add(wobble);
                    // Clamp to world bounds (allow slightly outside since mountains are big anyway)
                    const distFromOrigin = Math.sqrt(pos.x*pos.x + pos.z*pos.z);
                    if (distFromOrigin > WORLD_SIZE * 1.1) {
                        pos.multiplyScalar(WORLD_SIZE * 1.1 / distFromOrigin);
                    }
                    if (tooCloseToRiver(pos)) continue;
                    placeObject('mountain', pos);
                    const justPlaced = worldObjects[worldObjects.length - 1];
                    mountainFootprints.push({ pos: pos.clone(), radius: justPlaced.userData.footprint / 2 });
                }
            } else {
                // Ring: mountains around the perimeter (5-7 evenly distributed)
                mountainCount = 5 + Math.floor(Math.random() * 3);
                const ringRadius = WORLD_SIZE * 0.85;
                const startAngle = Math.random() * Math.PI * 2;
                for (let i = 0; i < mountainCount; i++) {
                    const angle = startAngle + (i / mountainCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
                    const r = ringRadius + (Math.random() - 0.5) * 25;
                    const pos = new THREE.Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r);
                    if (tooCloseToRiver(pos)) continue;
                    placeObject('mountain', pos);
                    const justPlaced = worldObjects[worldObjects.length - 1];
                    mountainFootprints.push({ pos: pos.clone(), radius: justPlaced.userData.footprint / 2 });
                }
            }

            // Helper: don't place trees on top of mountain footprints
            function tooCloseToMountain(pos) {
                return mountainFootprints.some(f => f.pos.distanceTo(pos) < f.radius + 4);
            }

            // Spawn 30-60 trees scattered across the world
            const treeCount = 30 + Math.floor(Math.random() * 30);
            let placed = 0;
            let attempts = 0;
            while (placed < treeCount && attempts < treeCount * 4) {
                attempts++;
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * (WORLD_SIZE - 10);
                const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
                if (tooCloseToRiver(pos)) continue;
                if (tooCloseToMountain(pos)) continue;
                placeObject('tree', pos);
                placed++;
            }

            // Spawn 6-15 animals (mixed species) scattered around
            const animalCount = 6 + Math.floor(Math.random() * 10);
            let animalsPlaced = 0;
            let animalAttempts = 0;
            while (animalsPlaced < animalCount && animalAttempts < animalCount * 4) {
                animalAttempts++;
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * (WORLD_SIZE - 10);
                const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
                if (tooCloseToRiver(pos)) continue;
                if (tooCloseToMountain(pos)) continue;
                placeObject('animal', pos);
                animalsPlaced++;
            }

            const features = [];
            if (hasRiver) features.push('River');
            if (mountainCount > 0) features.push(mountainCount + ' Mountains');
            features.push(animalsPlaced + ' Animals');
            spawnGrass();
            showMessage(features.length ? `Generated · ${features.join(' · ')}` : 'Terrain Generated');
        }

        function igniteRadius(center, radius, includeFallen = false) {
            worldObjects.forEach(obj => {
                if (obj.userData.type === 'road') return;
                // Fallen logs only catch from direct ignition (e.g. flamethrower tool), not passive spread
                if (!includeFallen && obj.userData.type === 'tree' && (obj.userData.hasFallen || obj.userData.isFalling)) return;
                const d = obj.position.distanceTo(center);
                if (d < radius) {
                    obj.userData.onFire = true;
                }
            });
            debris.forEach(d => {
                if (d.position.distanceTo(center) < radius) {
                    d.userData.onFire = true;
                }
            });
            cyclopses.forEach(c => {
                if (c.state === 'dying' || c.state === 'dead') return;
                if (c.mesh.position.distanceTo(center) < radius) {
                    c.onFire = true;
                }
            });
        }

        function applyBlast(center, radius, force, lift, damage, heat = false, excludeCyclopses = false) {
            worldObjects.forEach(obj => {
                if (obj.userData.frozen) return;   // CORPSES DON'T REACT
                const d = obj.position.distanceTo(center);
                if (d >= radius) return;
                const p = 1 - (d/radius);
                if (obj.userData.isStatic) {
                    // Static objects (roads, mountains) don't move from blasts but mountains
                    // can still be damaged. Roads have huge HP so they survive normal blasts.
                    if (obj.userData.type === 'mountain') {
                        obj.userData.hp -= p * damage;
                    } else if (obj.userData.type === 'road') {
                        obj.userData.hp -= p * damage * 0.1; // roads are tough
                    }
                    return;
                }
                obj.userData.velocity.add(
                    new THREE.Vector3().subVectors(obj.position, center).normalize().multiplyScalar(p * force)
                        .add(new THREE.Vector3(0, p * lift, 0))
                );
                // Humans are fragile — anything inside the blast radius is fatal.
                if ((obj.userData.type === 'human' || obj.userData.type === 'builder')) {
                    obj.userData.hp = 0;
                } else {
                    obj.userData.hp -= p * damage;
                }
                if (heat && Math.random() < p * 0.5) {
                    // Fallen logs don't catch from heat — only direct ignition
                    const isFallen = obj.userData.type === 'tree' && (obj.userData.hasFallen || obj.userData.isFalling);
                    if (!isFallen) obj.userData.onFire = true;
                }
            });
            // Debris also gets blown around
            debris.forEach(d => {
                const dist = d.position.distanceTo(center);
                if (dist < radius) {
                    const p = 1 - (dist/radius);
                    d.userData.velocity.add(
                        new THREE.Vector3().subVectors(d.position, center).normalize().multiplyScalar(p * force * 0.6)
                            .add(new THREE.Vector3(0, p * lift * 0.5, 0))
                    );
                    d.userData.settled = false;
                    d.userData.hp -= p * damage * 0.3;
                    if (heat && Math.random() < p * 0.5) d.userData.onFire = true;
                }
            });
            // Cyclopses also take damage from blasts (unless explicitly excluded, e.g. their own smashes)
            if (!excludeCyclopses) {
                cyclopses.forEach(c => {
                    if (c.state === 'dying' || c.state === 'dead') return;
                    const dist = c.mesh.position.distanceTo(center);
                    if (dist < radius) {
                        const p = 1 - (dist / radius);
                        c.hp -= p * damage * 0.6; // resilient but not invincible
                        if (heat && Math.random() < p * 0.4) c.onFire = true;
                    }
                });
            }
        }

        // --- EARTHQUAKE: houses tilt and split, trees fall ---
        function earthquake() {
            let frames = 0;
            const triggered = new Set();
            const itv = setInterval(() => {
                frames++;
                const intensity = Math.max(0, (150 - frames) / 150);
                renderer.domElement.style.transform = `translate(${(Math.random()-0.5)*30*intensity}px, ${(Math.random()-0.5)*30*intensity}px)`;

                worldObjects.forEach(o => {
                    if (o.userData.type === 'road') return; // roads stay put
                    if (triggered.has(o.uuid)) return;

                    if (o.userData.type === 'tree') {
                        // Trees: random chance per second to topple (only if not already fallen)
                        if (!o.userData.isFalling && !o.userData.hasFallen && Math.random() < 0.02) {
                            o.userData.isFalling = true;
                            o.userData.fallAxis = new THREE.Vector3(Math.random()-0.5, 0, Math.random()-0.5).normalize();
                            o.userData.fallAngle = 0;
                            // Kill humans within the tree's reach
                            const treeReach = (o.userData.trunkHeight || 5) * 1.2;
                            worldObjects.forEach(victim => {
                                if ((victim.userData.type === 'human' || victim.userData.type === 'builder') &&
                                    victim.position.distanceTo(o.position) < treeReach) {
                                    victim.userData.hp = 0;
                                }
                            });
                            triggered.add(o.uuid);
                        }
                    } else if (o.userData.type === 'house') {
                        // Houses: take damage, may split in half
                        // Skeletons (already burned) are more fragile and split sooner.
                        const damageRate = o.userData.skeleton ? 8 : 4;
                        const splitThreshold = o.userData.skeleton ? 0.7 : 0.5;
                        const splitChance = o.userData.skeleton ? 0.06 : 0.04;

                        o.userData.hp -= damageRate;
                        // Tilt slightly each tick
                        o.rotation.x += (Math.random()-0.5) * 0.015;
                        o.rotation.z += (Math.random()-0.5) * 0.015;
                        if (o.userData.hp < o.userData.maxHp * splitThreshold && Math.random() < splitChance) {
                            // Kill humans near the collapsing house
                            const collapsePos = o.position.clone();
                            worldObjects.forEach(victim => {
                                if ((victim.userData.type === 'human' || victim.userData.type === 'builder') &&
                                    victim.position.distanceTo(collapsePos) < 18) {
                                    victim.userData.hp = 0;
                                }
                            });
                            splitHouse(o);
                            triggered.add(o.uuid);
                        }
                    } else if ((o.userData.type === 'human' || o.userData.type === 'builder')) {
                        // Humans stumble
                        o.userData.velocity.x += (Math.random()-0.5) * 0.1;
                        o.userData.velocity.z += (Math.random()-0.5) * 0.1;
                        if (Math.random() < 0.005) o.userData.hp -= 5;
                    }
                });

                if (frames > 150) { clearInterval(itv); renderer.domElement.style.transform = ''; }
            }, 30);
        }

        // Split house into two halves that preserve the actual structure (windows, doors, roof, chimney).
        // We partition the original meshes by their local X coordinate — left half goes to one rubble piece,
        // right half goes to the other. Each half then tilts and falls outward.
        function splitHouse(house) {
            const halfA = new THREE.Group(); // left half (negative X)
            const halfB = new THREE.Group(); // right half (positive X)

            // Take a snapshot of children since we'll be moving them
            const childrenSnapshot = [...house.children];

            childrenSnapshot.forEach(child => {
                // Get the child's local X to decide which half it belongs to
                const localX = child.position.x;
                // Check if this mesh STRADDLES the split (its center is near 0 but it extends both ways)
                let geomWidth = 0;
                if (child.geometry) {
                    if (child.geometry.parameters && child.geometry.parameters.width) {
                        geomWidth = child.geometry.parameters.width;
                    } else if (child.geometry.parameters && child.geometry.parameters.radius) {
                        geomWidth = child.geometry.parameters.radius * 2;
                    } else if (child.geometry.boundingBox) {
                        geomWidth = child.geometry.boundingBox.max.x - child.geometry.boundingBox.min.x;
                    } else {
                        // ExtrudeGeometry / unknown — compute bounding box
                        child.geometry.computeBoundingBox();
                        if (child.geometry.boundingBox) {
                            geomWidth = child.geometry.boundingBox.max.x - child.geometry.boundingBox.min.x;
                        }
                    }
                }
                const halfWidth = geomWidth / 2;
                const straddles = Math.abs(localX) < halfWidth * 0.6;

                if (straddles && geomWidth > 1) {
                    // Clone this mesh: one copy for each half. Apply a clipping shift
                    // by scaling the X dimension to half and offsetting it.
                    // Simpler: clone + offset slightly so each appears as the half.
                    const cloneA = child.clone();
                    const cloneB = child.clone();
                    // Scale each half's geometry along X
                    cloneA.scale.x = 0.5;
                    cloneB.scale.x = 0.5;
                    // Shift each toward its respective side
                    cloneA.position.x = localX - halfWidth * 0.25;
                    cloneB.position.x = localX + halfWidth * 0.25;
                    // Need separate materials so they can be charred independently
                    if (cloneA.material) cloneA.material = cloneA.material.clone();
                    if (cloneB.material) cloneB.material = cloneB.material.clone();
                    halfA.add(cloneA);
                    halfB.add(cloneB);
                } else if (localX < 0) {
                    // Move whole mesh to halfA (clone to break shared materials)
                    const clone = child.clone();
                    if (clone.material) clone.material = clone.material.clone();
                    halfA.add(clone);
                } else {
                    const clone = child.clone();
                    if (clone.material) clone.material = clone.material.clone();
                    halfB.add(clone);
                }
            });

            halfA.position.copy(house.position);
            halfB.position.copy(house.position);
            halfA.rotation.copy(house.rotation);
            halfB.rotation.copy(house.rotation);

            // Determine fall direction in WORLD space based on house's Y rotation
            const yRot = house.rotation.y;
            // Local +X direction in world space
            const worldRight = new THREE.Vector3(Math.cos(yRot), 0, -Math.sin(yRot));
            const worldLeft = worldRight.clone().multiplyScalar(-1);

            halfA.userData = {
                type: 'rubble',
                velocity: worldLeft.clone().multiplyScalar(0.4).setY(0.3),
                hp: 120, maxHp: 120, onFire: false, burnLevel: 0,
                isStatic: false, isFalling: true,
                fallAxis: new THREE.Vector3(0, 0, 1), fallAngle: 0, fallDir: -1,
                spreadTimer: 0,
                dimensions: house.userData.dimensions,
                style: house.userData.style,
                roofType: house.userData.roofType,
                chimney: house.userData.chimney,
                skeleton: house.userData.skeleton // preserve charred state
            };
            halfB.userData = {
                type: 'rubble',
                velocity: worldRight.clone().multiplyScalar(0.4).setY(0.3),
                hp: 120, maxHp: 120, onFire: false, burnLevel: 0,
                isStatic: false, isFalling: true,
                fallAxis: new THREE.Vector3(0, 0, 1), fallAngle: 0, fallDir: 1,
                spreadTimer: 0,
                dimensions: house.userData.dimensions,
                style: house.userData.style,
                roofType: house.userData.roofType,
                chimney: house.userData.chimney,
                skeleton: house.userData.skeleton // preserve charred state
            };
            storeOriginalColors(halfA);
            storeOriginalColors(halfB);
            scene.add(halfA);
            scene.add(halfB);
            worldObjects.push(halfA);
            worldObjects.push(halfB);

            // Remove original house
            scene.remove(house);
            const idx = worldObjects.indexOf(house);
            if (idx >= 0) worldObjects.splice(idx, 1);
        }

        function explode(pt, r, color) {
            const e = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
            e.position.copy(pt); scene.add(e);
            let s = 1;
            const anim = setInterval(() => {
                s += r/12; e.scale.set(s,s,s); e.material.opacity -= 0.04;
                if (e.material.opacity <= 0) { scene.remove(e); clearInterval(anim); }
            }, 30);
        }

        // --- BURN: progressively char an object's colors toward black ---
        function applyBurnTint(group, level) {
            // level 0..1
            group.traverse(child => {
                if (child.isMesh && child.material && child.userData.originalColor !== undefined) {
                    const orig = new THREE.Color(child.userData.originalColor);
                    const charred = new THREE.Color(0x1a1a1a);
                    child.material.color.copy(orig).lerp(charred, level);
                }
            });
        }

        function burnedToSkeleton(group) {
            const type = group.userData.type;
            if (type === 'house' || type === 'rubble') {
                buildHouseSkeleton(group);
            } else if (type === 'skyscraper') {
                while (group.children.length > 0) group.remove(group.children[0]);
                const ud = group.userData;
                const h = ud.totalHeight || 25;
                const footprint = (ud.footprint || 8) * 0.45; // half-width of building

                // Steel frame colours — charred black with rust hints
                const steelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.5 });
                const rustMat  = new THREE.MeshStandardMaterial({ color: 0x2a1408, roughness: 1,   metalness: 0.3 });
                const ashMat   = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1 });

                // Number of floor levels to show (every ~3 units)
                const floorSpacing = 3;
                const floors = Math.floor(h / floorSpacing);

                // ─── 4 CORNER COLUMNS ─────────────────────────────────────
                const colW = 0.35;
                const corners = [
                    [ footprint, -footprint],
                    [-footprint, -footprint],
                    [ footprint,  footprint],
                    [-footprint,  footprint],
                ];
                corners.forEach(([cx, cz]) => {
                    // Full-height main column — tapers slightly
                    const colGeo = new THREE.BoxGeometry(colW, h, colW);
                    const col = new THREE.Mesh(colGeo, steelMat);
                    col.position.set(cx, h / 2, cz);
                    col.castShadow = true;
                    group.add(col);
                    // Small diagonal brace stubs at base (anchor footing)
                    const brace = new THREE.Mesh(
                        new THREE.BoxGeometry(colW * 2.5, colW, colW * 2.5),
                        rustMat
                    );
                    brace.position.set(cx, colW / 2, cz);
                    group.add(brace);
                });

                // ─── FLOOR PLATES every few floors ────────────────────────
                for (let f = 1; f <= floors; f++) {
                    const y = f * floorSpacing;
                    const partial = Math.random() < 0.4; // some floors partially gone
                    if (partial) {
                        // 2–3 stub beams instead of full plate
                        const beamCount = 2 + Math.floor(Math.random() * 2);
                        for (let b = 0; b < beamCount; b++) {
                            const bLen = footprint * (0.5 + Math.random() * 1.0);
                            const bx = (Math.random() - 0.5) * footprint;
                            const bz = (Math.random() - 0.5) * footprint;
                            const beam = new THREE.Mesh(
                                new THREE.BoxGeometry(bLen, 0.2, 0.25),
                                Math.random() < 0.5 ? steelMat : rustMat
                            );
                            beam.position.set(bx, y, bz);
                            beam.rotation.y = Math.random() * Math.PI;
                            beam.castShadow = true;
                            group.add(beam);
                        }
                    } else {
                        // Full cross-frame: two beams along X and Z
                        const span = footprint * 2;
                        for (const rot of [0, Math.PI / 2]) {
                            const plate = new THREE.Mesh(
                                new THREE.BoxGeometry(span, 0.18, 0.3),
                                steelMat
                            );
                            plate.position.set(0, y, 0);
                            plate.rotation.y = rot;
                            plate.castShadow = true;
                            group.add(plate);
                        }
                        // Diagonal X-brace on one face
                        if (Math.random() < 0.6) {
                            const diagLen = Math.sqrt(span * span + (floorSpacing) * (floorSpacing));
                            const diag = new THREE.Mesh(
                                new THREE.BoxGeometry(diagLen, 0.15, 0.15),
                                rustMat
                            );
                            diag.position.set(0, y - floorSpacing / 2, footprint);
                            diag.rotation.z = Math.atan2(floorSpacing, span);
                            diag.rotation.y = Math.random() < 0.5 ? 0 : Math.PI / 2;
                            group.add(diag);
                        }
                    }
                }

                // ─── HORIZONTAL PERIMETER BEAMS at every other floor ──────
                for (let f = 0; f <= floors; f++) {
                    if (f % 2 !== 0) continue;
                    const y = f * floorSpacing;
                    const fspan = footprint * 2;
                    const sides = [
                        { axis: 'x', offset:  footprint },
                        { axis: 'x', offset: -footprint },
                        { axis: 'z', offset:  footprint },
                        { axis: 'z', offset: -footprint },
                    ];
                    sides.forEach(s => {
                        if (Math.random() < 0.25) return; // some perimeter beams missing
                        const beam = new THREE.Mesh(
                            new THREE.BoxGeometry(fspan + 0.3, 0.25, 0.2),
                            steelMat
                        );
                        if (s.axis === 'x') {
                            beam.position.set(0, y, s.offset);
                        } else {
                            beam.position.set(s.offset, y, 0);
                            beam.rotation.y = Math.PI / 2;
                        }
                        beam.castShadow = true;
                        group.add(beam);
                    });
                }

                // ─── COLLAPSED UPPER SECTION ──────────────────────────────
                // The top third of the building leans and collapses
                const collapseStart = h * 0.65;
                const collapseH = h - collapseStart;
                const leanAngle = (Math.random() - 0.5) * 0.35;
                const leanDir = Math.random() * Math.PI * 2;

                const tiltGroup = new THREE.Group();
                tiltGroup.position.y = collapseStart;
                group.add(tiltGroup);

                // Leaning upper columns
                corners.forEach(([cx, cz]) => {
                    const col = new THREE.Mesh(
                        new THREE.BoxGeometry(colW, collapseH, colW),
                        steelMat
                    );
                    col.position.set(cx, collapseH / 2, cz);
                    col.castShadow = true;
                    tiltGroup.add(col);
                });
                // A couple of bent beams in the collapse zone
                for (let b = 0; b < 4; b++) {
                    const bLen = footprint * (1 + Math.random());
                    const bent = new THREE.Mesh(
                        new THREE.BoxGeometry(bLen, 0.2, 0.2),
                        rustMat
                    );
                    bent.position.set(
                        (Math.random() - 0.5) * footprint,
                        Math.random() * collapseH,
                        (Math.random() - 0.5) * footprint
                    );
                    bent.rotation.set(
                        (Math.random() - 0.5) * 0.6,
                        Math.random() * Math.PI,
                        (Math.random() - 0.5) * 0.6
                    );
                    bent.castShadow = true;
                    tiltGroup.add(bent);
                }
                // Apply the lean
                tiltGroup.rotation.x = Math.cos(leanDir) * leanAngle;
                tiltGroup.rotation.z = Math.sin(leanDir) * leanAngle;

                // ─── HANGING DEBRIS: twisted metal pieces dangling ─────────
                for (let d = 0; d < 8; d++) {
                    const dangLen = 1.5 + Math.random() * 3;
                    const dang = new THREE.Mesh(
                        new THREE.BoxGeometry(0.15, dangLen, 0.15),
                        Math.random() < 0.5 ? steelMat : ashMat
                    );
                    const floor = Math.floor(Math.random() * floors);
                    dang.position.set(
                        (Math.random() - 0.5) * footprint * 1.8,
                        floor * floorSpacing + dangLen / 2,
                        (Math.random() < 0.5 ? 1 : -1) * (footprint + 0.3)
                    );
                    dang.rotation.z = (Math.random() - 0.5) * 0.4;
                    dang.rotation.x = (Math.random() - 0.5) * 0.2;
                    dang.castShadow = true;
                    group.add(dang);
                }

                // ─── ASH / RUBBLE PILE at base ──────────────────────────
                for (let r = 0; r < 10; r++) {
                    const rSz = 0.3 + Math.random() * 0.8;
                    const rubble = new THREE.Mesh(
                        new THREE.BoxGeometry(rSz, rSz * 0.4, rSz),
                        ashMat
                    );
                    const ra = Math.random() * Math.PI * 2;
                    const rd = Math.random() * footprint * 1.5;
                    rubble.position.set(
                        Math.cos(ra) * rd,
                        rSz * 0.2,
                        Math.sin(ra) * rd
                    );
                    rubble.rotation.set(
                        (Math.random() - 0.5) * 0.5,
                        Math.random() * Math.PI,
                        (Math.random() - 0.5) * 0.5
                    );
                    group.add(rubble);
                }

                group.userData.skeleton = true;
                group.userData.onFire = false;
                group.userData.hp = 20;
            } else if (type === 'tree') {
                buildTreeSkeleton(group);
            } else if (type === 'human') {
                // Tiny char pile
                while (group.children.length > 0) group.remove(group.children[0]);
                const charMat = new THREE.MeshStandardMaterial({ color: 0x141414 });
                const pile = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), charMat);
                pile.position.y = 0.4;
                pile.scale.y = 0.3;
                group.add(pile);
                group.userData.skeleton = true;
                group.userData.onFire = false;
                group.userData.hp = 5;
            }
        }

        // ===== HOUSE SKELETON: style-specific charred remains =====
        function buildHouseSkeleton(group) {
            const ud = group.userData;
            const dims = ud.dimensions || { width: 8, depth: 8, height: 6, stories: 1 };
            const style = ud.style || 'cottage';
            const roofType = ud.roofType || 'gabled';
            const chimney = ud.chimney;
            const { width: W, depth: D, height: H, stories } = dims;

            // Remove all existing children
            while (group.children.length > 0) group.remove(group.children[0]);

            // Material varies by style — modern uses concrete/grey, cabin uses charred wood, etc.
            let postColor, beamColor, postThickness;
            if (style === 'modern' || style === 'townhouse') {
                postColor = 0x3f3f46; beamColor = 0x52525b; postThickness = 0.35;
            } else if (style === 'cabin') {
                postColor = 0x1c1310; beamColor = 0x1c1310; postThickness = 0.55; // thick charred logs
            } else if (style === 'manor') {
                postColor = 0x292524; beamColor = 0x44403c; postThickness = 0.5;
            } else if (style === 'tower') {
                postColor = 0x1f2937; beamColor = 0x1f2937; postThickness = 0.3;
            } else {
                postColor = 0x1a1a1a; beamColor = 0x1a1a1a; postThickness = 0.4;
            }

            const postMat = new THREE.MeshStandardMaterial({ color: postColor, roughness: 0.95 });
            const beamMat = new THREE.MeshStandardMaterial({ color: beamColor, roughness: 0.95 });

            // === CORNER POSTS ===
            const halfW = W / 2;
            const halfD = D / 2;
            const corners = [
                [-halfW, -halfD], [halfW, -halfD],
                [halfW,  halfD], [-halfW, halfD]
            ];
            corners.forEach(([x, z]) => {
                const post = new THREE.Mesh(
                    new THREE.BoxGeometry(postThickness, H, postThickness),
                    postMat
                );
                post.position.set(x, H / 2, z);
                post.castShadow = true;
                group.add(post);
            });

            // === HORIZONTAL FLOOR BEAMS at each story ===
            for (let s = 1; s <= stories; s++) {
                const yLevel = (H / stories) * s;
                // Two beams along the X axis
                const bx1 = new THREE.Mesh(new THREE.BoxGeometry(W, postThickness * 0.7, postThickness * 0.7), beamMat);
                bx1.position.set(0, yLevel, -halfD);
                group.add(bx1);
                const bx2 = new THREE.Mesh(new THREE.BoxGeometry(W, postThickness * 0.7, postThickness * 0.7), beamMat);
                bx2.position.set(0, yLevel, halfD);
                group.add(bx2);
                // Two beams along the Z axis
                const bz1 = new THREE.Mesh(new THREE.BoxGeometry(postThickness * 0.7, postThickness * 0.7, D), beamMat);
                bz1.position.set(-halfW, yLevel, 0);
                group.add(bz1);
                const bz2 = new THREE.Mesh(new THREE.BoxGeometry(postThickness * 0.7, postThickness * 0.7, D), beamMat);
                bz2.position.set(halfW, yLevel, 0);
                group.add(bz2);
            }

            // === ROOF SKELETON ===
            if (roofType === 'flat') {
                // Modern: just a flat charred slab edge
                const slab = new THREE.Mesh(new THREE.BoxGeometry(W + 0.2, 0.3, D + 0.2), beamMat);
                slab.position.y = H + 0.15;
                group.add(slab);
            } else if (roofType === 'gabled') {
                // Two slanted ridge beams forming a pitched skeleton
                const ridgeH = 3;
                const slope = Math.atan(ridgeH / (W / 2));
                const slantLen = Math.sqrt((W/2)*(W/2) + ridgeH*ridgeH);
                // Ridge beam at top
                const ridge = new THREE.Mesh(new THREE.BoxGeometry(postThickness * 0.7, postThickness * 0.7, D), beamMat);
                ridge.position.set(0, H + ridgeH, 0);
                group.add(ridge);
                // Sloped rafters
                for (const sign of [-1, 1]) {
                    for (let i = 0; i < 3; i++) {
                        const zPos = -halfD + (i / 2) * D;
                        const rafter = new THREE.Mesh(
                            new THREE.BoxGeometry(postThickness * 0.6, slantLen, postThickness * 0.6),
                            beamMat
                        );
                        rafter.position.set(sign * W / 4, H + ridgeH / 2, zPos);
                        rafter.rotation.z = sign * (Math.PI / 2 - slope);
                        group.add(rafter);
                    }
                }
            } else if (roofType === 'pyramid') {
                // 4 rafters converging to apex
                const apex = 3;
                for (const [cx, cz] of corners) {
                    const len = Math.sqrt(cx*cx + cz*cz + apex*apex);
                    const rafter = new THREE.Mesh(
                        new THREE.BoxGeometry(postThickness * 0.5, len, postThickness * 0.5),
                        beamMat
                    );
                    // Position midway between corner-top and apex
                    rafter.position.set(cx / 2, H + apex / 2, cz / 2);
                    // Aim from corner-top to apex
                    const dirVec = new THREE.Vector3(-cx, apex, -cz).normalize();
                    rafter.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirVec);
                    group.add(rafter);
                }
            } else if (roofType === 'cone') {
                // Tower: vertical apex pole + ribs
                const apex = 4;
                const apexPole = new THREE.Mesh(
                    new THREE.BoxGeometry(postThickness * 0.5, apex, postThickness * 0.5),
                    beamMat
                );
                apexPole.position.set(0, H + apex / 2, 0);
                group.add(apexPole);
                for (let r = 0; r < 6; r++) {
                    const angle = (r / 6) * Math.PI * 2;
                    const cx = Math.cos(angle) * W / 2;
                    const cz = Math.sin(angle) * D / 2;
                    const len = Math.sqrt(cx*cx + cz*cz + apex*apex);
                    const rafter = new THREE.Mesh(
                        new THREE.BoxGeometry(postThickness * 0.4, len, postThickness * 0.4),
                        beamMat
                    );
                    rafter.position.set(cx / 2, H + apex / 2, cz / 2);
                    const dirVec = new THREE.Vector3(-cx, apex, -cz).normalize();
                    rafter.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirVec);
                    group.add(rafter);
                }
            }

            // === CHIMNEY remains (only the brick column survives — even more iconic when alone) ===
            if (chimney) {
                // Chimney is brick, so it survives the fire — give it a sooty grey color
                const chimMat = new THREE.MeshStandardMaterial({ color: 0x4a4540, roughness: 0.95 });
                const chim = new THREE.Mesh(new THREE.BoxGeometry(0.9, H + 3.5, 0.9), chimMat);
                chim.position.set(chimney.x, (H + 3.5) / 2, chimney.z);
                chim.castShadow = true;
                group.add(chim);
            }

            // === SCATTERED ASH DEBRIS at base ===
            const ashMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 1.0 });
            for (let i = 0; i < 8; i++) {
                const ash = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3 + Math.random() * 0.4, 0.15, 0.3 + Math.random() * 0.4),
                    ashMat
                );
                ash.position.set(
                    (Math.random() - 0.5) * W * 0.9,
                    0.08,
                    (Math.random() - 0.5) * D * 0.9
                );
                ash.rotation.y = Math.random() * Math.PI;
                group.add(ash);
            }

            ud.skeleton = true;
            ud.hp = Math.round(50 * (1 + (stories - 1) * 0.3));
        }

        // ===== TREE SKELETON: species-specific charred remains =====
        function buildTreeSkeleton(group) {
            const ud = group.userData;
            const species = ud.species || 'oak';
            const tHeight = ud.trunkHeight || 5;

            while (group.children.length > 0) group.remove(group.children[0]);

            const charMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 });
            const darkMat = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.95 });

            if (species === 'pine' || species === 'cypress') {
                // Tall narrow charred spire with sparse short branches near top
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.04, tHeight * 0.08, tHeight, 6),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                // Small remnant branches near top
                const branchCount = 4 + Math.floor(Math.random() * 3);
                for (let i = 0; i < branchCount; i++) {
                    const len = 0.6 + Math.random() * 0.8;
                    const b = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.06, 0.1, len, 4),
                        darkMat
                    );
                    const yPos = tHeight * 0.55 + (i / branchCount) * tHeight * 0.4;
                    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
                    b.position.set(Math.cos(angle) * 0.3, yPos, Math.sin(angle) * 0.3);
                    b.rotation.z = Math.cos(angle) * Math.PI / 2.3;
                    b.rotation.x = -Math.sin(angle) * Math.PI / 2.3;
                    b.position.x += Math.cos(angle) * len * 0.4;
                    b.position.z += Math.sin(angle) * len * 0.4;
                    group.add(b);
                }
            } else if (species === 'oak') {
                // Thick gnarled trunk with several stout broken branches
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.18, tHeight * 0.25, tHeight, 8),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                // Stout broken branches
                const branchCount = 4 + Math.floor(Math.random() * 3);
                for (let i = 0; i < branchCount; i++) {
                    const len = 1.4 + Math.random() * 1;
                    const b = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.18, 0.28, len, 5),
                        darkMat
                    );
                    const yPos = tHeight * 0.65 + (i / branchCount) * tHeight * 0.3;
                    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.4;
                    b.position.set(Math.cos(angle) * 0.6, yPos, Math.sin(angle) * 0.6);
                    b.rotation.z = Math.cos(angle) * (Math.PI / 3.5);
                    b.rotation.x = -Math.sin(angle) * (Math.PI / 3.5);
                    b.position.x += Math.cos(angle) * len * 0.4;
                    b.position.z += Math.sin(angle) * len * 0.4;
                    b.position.y += len * 0.15;
                    b.castShadow = true;
                    group.add(b);
                    // Sub-twig stubs
                    if (Math.random() < 0.5) {
                        const twig = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.07, 0.12, 0.5 + Math.random() * 0.4, 4),
                            darkMat
                        );
                        twig.position.copy(b.position);
                        twig.position.x += Math.cos(angle) * 0.5;
                        twig.position.z += Math.sin(angle) * 0.5;
                        twig.rotation.z = Math.cos(angle) * Math.PI / 2.5;
                        twig.rotation.x = -Math.sin(angle) * Math.PI / 2.5;
                        group.add(twig);
                    }
                }
            } else if (species === 'birch') {
                // Slim trunk with very thin remnant twigs at top
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.04, tHeight * 0.06, tHeight, 6),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                // Just a couple of thin twigs sticking up
                for (let i = 0; i < 3; i++) {
                    const t = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.04, 0.06, 0.8, 4),
                        darkMat
                    );
                    const angle = (i / 3) * Math.PI * 2 + Math.random() * 0.5;
                    t.position.set(
                        Math.cos(angle) * 0.15,
                        tHeight + 0.3,
                        Math.sin(angle) * 0.15
                    );
                    t.rotation.z = Math.cos(angle) * 0.4;
                    t.rotation.x = -Math.sin(angle) * 0.4;
                    group.add(t);
                }
            } else if (species === 'maple') {
                // Medium thickness, branching pattern
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.1, tHeight * 0.15, tHeight, 7),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                const branchCount = 5 + Math.floor(Math.random() * 3);
                for (let i = 0; i < branchCount; i++) {
                    const len = 0.9 + Math.random() * 0.9;
                    const b = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.1, 0.16, len, 4),
                        darkMat
                    );
                    const yPos = tHeight * 0.55 + (i / branchCount) * tHeight * 0.4;
                    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.4;
                    b.position.set(Math.cos(angle) * 0.4, yPos, Math.sin(angle) * 0.4);
                    b.rotation.z = Math.cos(angle) * (Math.PI / 3);
                    b.rotation.x = -Math.sin(angle) * (Math.PI / 3);
                    b.position.x += Math.cos(angle) * len * 0.4;
                    b.position.z += Math.sin(angle) * len * 0.4;
                    b.position.y += len * 0.15;
                    group.add(b);
                }
            } else if (species === 'willow') {
                // Curved trunk + drooping charred strands
                const lower = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.12, tHeight * 0.16, tHeight * 0.55, 6),
                    charMat
                );
                lower.position.y = tHeight * 0.275;
                lower.castShadow = true;
                group.add(lower);
                const upper = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.08, tHeight * 0.12, tHeight * 0.5, 6),
                    charMat
                );
                upper.position.y = tHeight * 0.55 + (tHeight * 0.5) / 2;
                const tilt = (Math.random() - 0.5) * 0.2;
                upper.rotation.z = tilt;
                upper.position.x = Math.sin(tilt) * tHeight * 0.25;
                upper.castShadow = true;
                group.add(upper);
                // Drooping charred strands
                for (let s = 0; s < 6; s++) {
                    const strand = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.04, 0.03, 1.5 + Math.random(), 4),
                        darkMat
                    );
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1 + Math.random() * 0.5;
                    strand.position.set(
                        Math.cos(angle) * dist,
                        tHeight * 0.7,
                        Math.sin(angle) * dist
                    );
                    group.add(strand);
                }
            } else if (species === 'cherry') {
                // Slim charred trunk with delicate branches
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.06, tHeight * 0.08, tHeight, 6),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                const branchCount = 4 + Math.floor(Math.random() * 3);
                for (let i = 0; i < branchCount; i++) {
                    const len = 0.8 + Math.random() * 0.7;
                    const b = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.05, 0.08, len, 4),
                        darkMat
                    );
                    const yPos = tHeight * 0.7 + (i / branchCount) * tHeight * 0.25;
                    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
                    b.position.set(Math.cos(angle) * 0.2, yPos, Math.sin(angle) * 0.2);
                    b.rotation.z = Math.cos(angle) * Math.PI / 2.5;
                    b.rotation.x = -Math.sin(angle) * Math.PI / 2.5;
                    b.position.x += Math.cos(angle) * len * 0.4;
                    b.position.z += Math.sin(angle) * len * 0.4;
                    group.add(b);
                }
            } else if (species === 'dead') {
                // Already bare — just blacken what's there with a slim trunk + gnarled branches
                const trunk = new THREE.Mesh(
                    new THREE.CylinderGeometry(tHeight * 0.06, tHeight * 0.1, tHeight, 6),
                    charMat
                );
                trunk.position.y = tHeight / 2;
                trunk.castShadow = true;
                group.add(trunk);
                const branchCount = 5 + Math.floor(Math.random() * 4);
                for (let i = 0; i < branchCount; i++) {
                    const len = 1.5 + Math.random() * 1;
                    const b = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.06, 0.13, len, 4),
                        darkMat
                    );
                    const yPos = tHeight * 0.5 + (i / branchCount) * tHeight * 0.45;
                    const angle = (i / branchCount) * Math.PI * 2 + Math.random() * 0.5;
                    b.position.set(Math.cos(angle) * 0.4, yPos, Math.sin(angle) * 0.4);
                    b.rotation.z = Math.cos(angle) * (Math.PI / 2.8);
                    b.rotation.x = -Math.sin(angle) * (Math.PI / 2.8);
                    b.position.x += Math.cos(angle) * len * 0.4;
                    b.position.z += Math.sin(angle) * len * 0.4;
                    b.position.y += len * 0.2;
                    group.add(b);
                }
            }

            ud.skeleton = true;
            ud.hp = 9999; // burned trees don't die from burning — they just fall
            ud.onFire = false;
            // Only trigger falling animation if not already on the ground.
            if (!ud.hasFallen) {
                ud.isFalling = true;
                ud.fallAxis = new THREE.Vector3(Math.random()-0.5, 0, Math.random()-0.5).normalize();
                ud.fallAngle = 0;
            }
        }

        // Linearly interpolate between two hex colors based on t in [0,1]
        function lerpHex(a, b, t) {
            const ca = new THREE.Color(a);
            const cb = new THREE.Color(b);
            return ca.lerp(cb, t);
        }

        // Smooth interpolation
        function smoothstep(t) {
            return t * t * (3 - 2 * t);
        }

        function updateDayNight() {
            // dayPhase: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset, 1=back to midnight
            // Sun arcs from east horizon (sunrise) over the south to west horizon (sunset).
            // Below horizon during night.
            const sunAngle = (dayPhase - 0.25) * Math.PI * 2; // 0 at sunrise, π/2 at noon, π at sunset, 3π/2 midnight
            const sunY = Math.sin(sunAngle);
            const sunX = Math.cos(sunAngle);
            const distance = 400;
            window.sun.position.set(sunX * distance, sunY * distance, 50);

            // Sun visibility: 0 below horizon, full above
            const sunIntensity = Math.max(0, sunY); // 0..1

            // Determine palette by phase
            let skyColor, sunColor, hemiSky, hemiGround, ambientColor;
            let sunBrightness, ambientBrightness, hemiBrightness, fillBrightness;

            if (sunY > 0.3) {
                // Day
                skyColor = 0x87ceeb;
                sunColor = 0xffffff;
                hemiSky = 0xffffff;
                hemiGround = 0x556677;
                ambientColor = 0xffffff;
                sunBrightness = 1.6;
                ambientBrightness = 0.5;
                hemiBrightness = 0.9;
                fillBrightness = 0.6;
            } else if (sunY > 0) {
                // Sunrise/sunset blend (warm orange)
                const t = sunY / 0.3;
                skyColor = lerpHex(0xff7e3f, 0x87ceeb, smoothstep(t)).getHex();
                sunColor = lerpHex(0xffaa55, 0xffffff, smoothstep(t)).getHex();
                hemiSky = lerpHex(0xff8855, 0xffffff, smoothstep(t)).getHex();
                hemiGround = lerpHex(0x4a3a2a, 0x556677, smoothstep(t)).getHex();
                ambientColor = lerpHex(0xff9966, 0xffffff, smoothstep(t)).getHex();
                sunBrightness = 0.6 + t * 1.0;
                ambientBrightness = 0.35 + t * 0.15;
                hemiBrightness = 0.5 + t * 0.4;
                fillBrightness = 0.3 + t * 0.3;
            } else if (sunY > -0.15) {
                // Twilight (deep orange/purple)
                const t = (sunY + 0.15) / 0.15;
                skyColor = lerpHex(0x2a1a3a, 0xff5e2f, smoothstep(t)).getHex();
                sunColor = lerpHex(0x4a3060, 0xff7733, smoothstep(t)).getHex();
                hemiSky = lerpHex(0x4a2a5a, 0xff7755, smoothstep(t)).getHex();
                hemiGround = lerpHex(0x1a1a2a, 0x4a3a2a, smoothstep(t)).getHex();
                ambientColor = lerpHex(0x4a3a55, 0xff9966, smoothstep(t)).getHex();
                sunBrightness = t * 0.6;
                ambientBrightness = 0.2 + t * 0.15;
                hemiBrightness = 0.3 + t * 0.2;
                fillBrightness = 0.2 + t * 0.1;
            } else {
                // Night
                skyColor = 0x0a0e2a;
                sunColor = 0x6a7099; // moon-like
                hemiSky = 0x2a3a5a;
                hemiGround = 0x0a0f1a;
                ambientColor = 0x3a4a66;
                sunBrightness = 0.15;
                ambientBrightness = 0.18;
                hemiBrightness = 0.25;
                fillBrightness = 0.15;
            }

            // Apply
            scene.background = new THREE.Color(skyColor);
            scene.fog.color = new THREE.Color(skyColor);
            window.sun.color.setHex(sunColor);
            window.sun.intensity = sunBrightness;
            window.hemiLight.color.setHex(hemiSky);
            window.hemiLight.groundColor.setHex(hemiGround);
            window.hemiLight.intensity = hemiBrightness;
            window.ambient.color.setHex(ambientColor);
            window.ambient.intensity = ambientBrightness;
            window.fillLight.intensity = fillBrightness;

            // Windows: lit at night (sunY < 0.15), dark during day
            const wantNight = sunY < 0.15;
            if (wantNight !== windowsAreNightMode) {
                windowsAreNightMode = wantNight;
                updateWindowLighting(wantNight);
            }

            // Advance time only in auto mode
            if (dayNightMode === 'auto') {
                dayPhase += 1 / DAY_LENGTH;
                if (dayPhase >= 1) dayPhase -= 1;
            }
        }

        // Walk all placed buildings and set window emissive based on day/night
        function updateWindowLighting(isNight) {
            worldObjects.forEach(obj => {
                const t = obj.userData.type;
                if (t !== 'house' && t !== 'skyscraper') return;
                if (obj.userData.skeleton) return;
                obj.traverse(child => {
                    if (!child.isMesh) return;
                    if (!child.userData.isWindow) return;
                    const mat = child.material;
                    if (!mat || !mat.emissive) return;
                    if (isNight && child.userData.windowLit) {
                        // Night and window is "occupied" — glow warm yellow
                        mat.color.set(0xfef3c7);
                        mat.emissive.set(0xfde047);
                        mat.emissiveIntensity = 0.7;
                        mat.opacity = 0.95;
                    } else {
                        // Day or unlit window — dark glass
                        mat.color.set(0x1e293b);
                        mat.emissive.set(0x000000);
                        mat.emissiveIntensity = 0;
                        mat.opacity = 0.7;
                    }
                });
            });
        }

        // WASD look-around keys (global, work in all modes)
        // ── FREE-FLY CAMERA (simulator + construction modes) ──────────────
        const flyKeys = {};
        let flyYaw = -Math.PI / 4;
        let flyPitch = -0.5;
        let flyMouseDown = false;
        let flyLastX = 0, flyLastY = 0;
        let flyTouchId = null, flyTouchLX = 0, flyTouchLY = 0;
        // Smoothed trackpad velocities — fed by wheel events, decayed each frame
        let flyVelForward = 0;
        let flyVelRight   = 0;
        let flyVelUp      = 0;
        // Smoothed mouse-look deltas
        let flyLookDX = 0, flyLookDY = 0;

        window.addEventListener('keydown', e => { flyKeys[e.code] = true; });
        window.addEventListener('keyup',   e => { flyKeys[e.code] = false; });
        window.addEventListener('mouseup', e => { flyMouseDown = false; });
        window.addEventListener('mousemove', e => {
            if (!flyMouseDown || !isFlyMode()) return;
            flyLookDX += (e.clientX - flyLastX) * 0.008;
            flyLookDY += (e.clientY - flyLastY) * 0.008;
            flyLastX = e.clientX; flyLastY = e.clientY;
        });

        function setupFlyCameraEvents() {
            renderer.domElement.addEventListener('mousedown', e => {
                if (!isFlyMode()) return;
                // Any mouse button starts a look drag
                flyMouseDown = true;
                flyLastX = e.clientX; flyLastY = e.clientY;
                if (e.button === 2) e.preventDefault();
            });
            renderer.domElement.addEventListener('contextmenu', e => {
                if (isFlyMode()) e.preventDefault();
            });

            // ── TRACKPAD & MOUSE WHEEL ────────────────────────────────────
            // ctrlKey=true  → pinch-to-zoom  → move forward/back
            // ctrlKey=false → two-finger pan → strafe + elevate (deltaX/deltaY)
            // ── TRACKPAD SMOOTHING: accumulate velocity, decay each frame ──
            // Instead of applying deltas directly we feed them into a smoothed velocity
            // that gets applied in applyFlyCamera() and decays with friction.
            // This gives buttery inertia — fast flick coasts, slow drag is precise.

            renderer.domElement.addEventListener('wheel', e => {
                if (!isFlyMode()) return;
                e.preventDefault();

                const isPinch = e.ctrlKey;
                const isTrackpadPan = !isPinch && Math.abs(e.deltaX) > 0.5;

                // Clamp raw deltas to avoid huge spikes on first event after pause
                const clamp = (v, max) => Math.max(-max, Math.min(max, v));
                const dx = clamp(e.deltaX, 80);
                const dy = clamp(e.deltaY, 80);

                if (isPinch) {
                    flyVelForward -= dy * 0.08;
                } else if (isTrackpadPan) {
                    flyVelRight  += dx * 0.05;
                    flyVelUp     -= dy * 0.05;
                } else {
                    flyVelForward -= dy * 0.22;
                }
            }, { passive: false });

            renderer.domElement.addEventListener('touchstart', e => {
                if (!isFlyMode() || e.touches.length < 2) return;
                flyTouchId = e.touches[0].identifier;
                flyTouchLX = e.touches[0].clientX;
                flyTouchLY = e.touches[0].clientY;
            }, { passive: true });
            renderer.domElement.addEventListener('touchmove', e => {
                if (!isFlyMode() || e.touches.length < 2) return;
                const t = e.touches[0];
                flyYaw   -= (t.clientX - flyTouchLX) * 0.010;
                flyPitch -= (t.clientY - flyTouchLY) * 0.010;
                flyPitch  = Math.max(-Math.PI/2+0.05, Math.min(Math.PI/2-0.05, flyPitch));
                flyTouchLX = t.clientX; flyTouchLY = t.clientY;
            }, { passive: true });
        }

        function initFlyCamera() {
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            flyYaw   = Math.atan2(-dir.x, -dir.z);
            flyPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        }

        function isFlyMode() {
            return (gameMode === 'simulator' || gameMode === 'construction') && !tourActive;
        }

        function applyFlyCamera() {
            if (!isFlyMode()) return;

            const isShift = flyKeys['ShiftLeft'] || flyKeys['ShiftRight'];
            const KEY_ACCEL  = isShift ? 0.5 : 0.14;   // keyboard: gentle ramp
            const FRICTION   = 0.88;
            const LOOK_SPEED = 0.04;

            // ── Mouse look: apply accumulated deltas this frame ───────────
            flyYaw   -= flyLookDX;
            flyPitch -= flyLookDY;
            flyPitch  = Math.max(-Math.PI/2+0.05, Math.min(Math.PI/2-0.05, flyPitch));
            flyLookDX = 0;
            flyLookDY = 0;

            // ── Arrow key look ────────────────────────────────────────────
            if (flyKeys['ArrowLeft'])  flyYaw   += LOOK_SPEED;
            if (flyKeys['ArrowRight']) flyYaw   -= LOOK_SPEED;
            if (flyKeys['ArrowUp'])    flyPitch  = Math.min( Math.PI/2-0.05, flyPitch + LOOK_SPEED);
            if (flyKeys['ArrowDown'])  flyPitch  = Math.max(-Math.PI/2+0.05, flyPitch - LOOK_SPEED);

            // ── Direction vectors ─────────────────────────────────────────
            const cosPitch = Math.cos(flyPitch);
            const forward = new THREE.Vector3(-Math.sin(flyYaw)*cosPitch, Math.sin(flyPitch), -Math.cos(flyYaw)*cosPitch).normalize();
            const right   = new THREE.Vector3( Math.cos(flyYaw), 0, -Math.sin(flyYaw)).normalize();
            const up      = new THREE.Vector3(0, 1, 0);

            // ── WASD/QE: feed into velocity (same pool as trackpad) ───────
            if (flyKeys['KeyW']) flyVelForward = Math.min( 20, flyVelForward + KEY_ACCEL);
            if (flyKeys['KeyS']) flyVelForward = Math.max(-20, flyVelForward - KEY_ACCEL);
            if (flyKeys['KeyD']) flyVelRight   = Math.min( 20, flyVelRight   + KEY_ACCEL);
            if (flyKeys['KeyA']) flyVelRight   = Math.max(-20, flyVelRight   - KEY_ACCEL);
            if (flyKeys['KeyQ'] || flyKeys['Space']) flyVelUp = Math.min( 20, flyVelUp + KEY_ACCEL);
            if (flyKeys['KeyE'] || flyKeys['KeyC'])  flyVelUp = Math.max(-20, flyVelUp - KEY_ACCEL);

            // ── Apply unified velocity ────────────────────────────────────
            camera.position.addScaledVector(forward, flyVelForward);
            camera.position.addScaledVector(right,   flyVelRight);
            camera.position.addScaledVector(up,      flyVelUp);

            // ── Friction decay ────────────────────────────────────────────
            flyVelForward *= FRICTION;
            flyVelRight   *= FRICTION;
            flyVelUp      *= FRICTION;
            if (Math.abs(flyVelForward) < 0.002) flyVelForward = 0;
            if (Math.abs(flyVelRight)   < 0.002) flyVelRight   = 0;
            if (Math.abs(flyVelUp)      < 0.002) flyVelUp      = 0;

            // ── Apply rotation ────────────────────────────────────────────
            camera.rotation.order = 'YXZ';
            camera.rotation.y = flyYaw;
            camera.rotation.x = flyPitch;
            camera.rotation.z = 0;

            controls.target.copy(camera.position).addScaledVector(forward, 10);
        }

        function animate() {
            requestAnimationFrame(animate);
            applyFlyCamera();
            // OrbitControls only active in survival (unused) — fly camera handles sim/construction
            if (gameMode === 'survival') controls.update();

            // Pulse multi-target markers so they're easy to see
            if (multiTargetMarkers.length > 0) {
                const pulse = 0.7 + Math.sin(Date.now() * 0.006) * 0.3;
                multiTargetMarkers.forEach(m => {
                    if (m.material) m.material.opacity = pulse;
                    m.rotation.z += 0.03;
                });
            }

            updateDayNight();
            // Survival mode: drive player + camera here so it's in sync with the rest of the sim
            if (gameMode === 'survival' && survivalActive) updateSurvival();
            updateOctopuses();
            updateLeviathans();
            updateKrakens();
            updateConstruction();
            updateTour();
            updateTour();

            // Auto-spawn residents periodically — but cap at ~2 per house
            residentSpawnTimer++;
            if (residentSpawnTimer >= 360) { // every ~6 seconds
                residentSpawnTimer = 0;
                const houses = worldObjects.filter(o =>
                    o.userData.type === 'house' && o.userData.hp > 0 && !o.userData.skeleton
                );
                if (houses.length > 0) {
                    const residentCount = worldObjects.filter(o =>
                        o.userData.type === 'human' && !o.userData.isCorpse && o.userData.hp > 0
                    ).length;
                    const targetCap = houses.length * 2;
                    if (residentCount < targetCap) {
                        // Pick a random house, spawn a resident at its doorstep
                        const house = houses[Math.floor(Math.random() * houses.length)];
                        // Door is on +Z face of the (rotated) house. Compute world doorstep.
                        const fp = house.userData.footprint || 8;
                        const doorOffset = new THREE.Vector3(0, 0, fp / 2 + 2);
                        doorOffset.applyEuler(new THREE.Euler(0, house.rotation.y, 0));
                        const spawnPos = new THREE.Vector3(
                            house.position.x + doorOffset.x,
                            0,
                            house.position.z + doorOffset.z
                        );
                        placeObject('human', spawnPos);
                    }
                }
            }

            // Tornado visuals + lifecycle
            for (let ti = tornadoes.length - 1; ti >= 0; ti--) {
                const t = tornadoes[ti];
                t.age++;
                t.mesh.rotation.y += 0.15;
                t.mesh.children.forEach((c, i) => {
                    c.rotation.y += 0.05 * (i+1);
                });
                // Fade out near end of life
                if (t.age > 400) {
                    t.mesh.children.forEach(c => {
                        c.material.opacity *= 0.95;
                    });
                }
                // Fully despawn after ~9 seconds (540 frames)
                if (t.age > 540) {
                    despawnTornado(t);
                    tornadoes.splice(ti, 1);
                }
            }

            // Volcano: lifecycle, gradual cooldown, bubbling lava, smoke plume, lava streams
            for (let vi = volcanoes.length - 1; vi >= 0; vi--) {
                const v = volcanoes[vi];
                v.age++;

                // Singularity sucks in volcanoes
                if (singularityPoint) {
                    const toSing = new THREE.Vector3().subVectors(singularityPoint, v.mesh.position);
                    const d = toSing.length();
                    const strength = Math.max(0.05, 30 / (d + 30));
                    v.mesh.position.add(toSing.normalize().multiplyScalar(strength));
                    if (d < 50) {
                        const sc = Math.max(0.05, d / 50);
                        v.mesh.scale.set(sc, sc, sc);
                    }
                    if (d < 8) {
                        // Consumed — also clean up its smoke
                        v.smokeParticles.forEach(sm => scene.remove(sm));
                        despawnVolcano(v);
                        volcanoes.splice(vi, 1);
                        continue;
                    }
                }

                // Compute eruption intensity over the life — full power for first half,
                // then gradually fades to 0.
                let intensity;
                if (v.age < v.lifeMax * 0.5) {
                    intensity = 1.0;
                } else if (v.age < v.lifeMax) {
                    intensity = 1 - (v.age - v.lifeMax * 0.5) / (v.lifeMax * 0.5);
                } else {
                    intensity = 0;
                }
                v.eruptionIntensity = intensity;

                // Pulse the crater light proportional to intensity
                v.craterLight.intensity = (2.5 + Math.sin(v.age * 0.2) * 1.5) * intensity;

                // Animate lava bubbles — bob up and down
                v.lavaBubbles.forEach(b => {
                    b.userData.phase += 0.1;
                    b.position.y = b.userData.baseY + Math.sin(b.userData.phase) * 0.3 * intensity;
                    b.scale.setScalar(0.6 + Math.sin(b.userData.phase * 0.8) * 0.3);
                });
                // Lava core flicker
                const lavaColor = intensity > 0.05
                    ? (Math.random() < 0.5 ? 0xff6600 : 0xffaa00)
                    : 0x331008; // cooled
                v.lavaCoreMat.color.setHex(lavaColor);

                // Lava streams: brighten/dim with intensity
                v.lavaStreams.forEach(s => {
                    s.material.opacity = 0.9 * intensity;
                });

                // Smoke plume: continuous emission while erupting
                if (intensity > 0.05 && v.age % 4 === 0) {
                    const smoke = new THREE.Mesh(
                        new THREE.SphereGeometry(2 + Math.random() * 1.5, 8, 6),
                        new THREE.MeshBasicMaterial({
                            color: intensity > 0.5 ? 0x444444 : 0x666666,
                            transparent: true,
                            opacity: 0.5 * intensity
                        })
                    );
                    smoke.position.set(
                        v.point.x + (Math.random() - 0.5) * 2,
                        v.height + 2,
                        v.point.z + (Math.random() - 0.5) * 2
                    );
                    smoke.userData = {
                        vel: new THREE.Vector3(
                            (Math.random() - 0.5) * 0.05,
                            0.3 + Math.random() * 0.2,
                            (Math.random() - 0.5) * 0.05
                        ),
                        life: 1.0,
                        smoke: true
                    };
                    scene.add(smoke);
                    v.smokeParticles.push(smoke);
                }
                // Update smoke particles
                for (let si = v.smokeParticles.length - 1; si >= 0; si--) {
                    const sm = v.smokeParticles[si];
                    sm.position.add(sm.userData.vel);
                    sm.userData.vel.y *= 0.99;
                    sm.userData.life -= 0.005;
                    sm.material.opacity = 0.5 * sm.userData.life;
                    sm.scale.multiplyScalar(1.012);
                    if (sm.userData.life <= 0) {
                        scene.remove(sm);
                        v.smokeParticles.splice(si, 1);
                    }
                }

                // Erupt lava bombs proportional to intensity
                if (intensity > 0.1 && v.age % Math.max(8, Math.floor(20 / intensity)) === 0) {
                    spawnLavaBomb(v.point, v.height);
                }

                // Grow lava pool over time (only while erupting)
                if (intensity > 0.1) {
                    const targetRadius = Math.min(70, 1 + v.age * 0.04);
                    if (v.poolRadius < targetRadius) {
                        v.poolRadius = targetRadius;
                        v.lavaPool.scale.set(v.poolRadius, v.poolRadius, 1);
                    }
                }

                // Cool down the pool gradually as intensity drops
                if (intensity < 1) {
                    v.lavaPool.material.emissiveIntensity = 0.8 * intensity;
                    const cooled = new THREE.Color(0x2a1a14);
                    const hot = new THREE.Color(0xff4500);
                    v.lavaPool.material.color.copy(hot).lerp(cooled, 1 - intensity);
                }

                // Damage objects standing in the lava pool — burn them (only while pool is hot)
                if (intensity > 0.2) {
                    worldObjects.forEach(obj => {
                        if (obj.userData.frozen) return;
                        if (obj.userData.type === 'road') return;
                        if (obj === v.mesh) return;
                        const dx = obj.position.x - v.point.x;
                        const dz = obj.position.z - v.point.z;
                        const d = Math.sqrt(dx*dx + dz*dz);
                        if (d < v.poolRadius && d > v.radius * 0.6) {
                            obj.userData.onFire = true;
                            obj.userData.hp -= 0.5 * intensity;
                        }
                    });

                    // Volcano lava pool meets river — both dry up
                    for (let ri = rivers.length - 1; ri >= 0; ri--) {
                        const river = rivers[ri];
                        if (river.userData.dried) continue;
                        const rPos = river.geometry.attributes.position;
                        let hit = false;
                        for (let vi = 0; vi < rPos.count; vi += 3) {
                            const dx = rPos.getX(vi) - v.point.x;
                            const dz = rPos.getZ(vi) - v.point.z;
                            if (Math.sqrt(dx*dx + dz*dz) < v.poolRadius + 4) { hit = true; break; }
                        }
                        if (hit) {
                            // Steam
                            for (let s = 0; s < 10; s++) {
                                createFireParticle(new THREE.Vector3(
                                    v.point.x + (Math.random()-0.5)*10,
                                    2 + Math.random()*4,
                                    v.point.z + (Math.random()-0.5)*10
                                ), true);
                            }
                            // Dry river
                            river.material.color.set(0x8b7355);
                            river.material.emissive.set(0x000000);
                            river.material.emissiveIntensity = 0;
                            river.material.opacity = 0.7;
                            river.userData.dried = true;
                            // Reduce volcano pool intensity
                            v.age = Math.max(v.age, v.lifeMax * 0.6);
                        }
                    }
                }

                // The volcano never fully despawns — once dormant, the cone stays as terrain.
                // (Don't remove from array; just stop animating actively.)
                // Optionally let the user erase it via the eraser tool by treating it like a worldObject.
            }

            // Lava bombs and firebombs: arc through the air, ignite/explode where they land
            for (let i = lavaBombs.length - 1; i >= 0; i--) {
                const b = lavaBombs[i];
                b.position.add(b.userData.vel);
                const grav = b.userData.gravity || 0.04;
                b.userData.vel.y -= grav;
                b.userData.age = (b.userData.age || 0) + 1;
                b.rotation.x += 0.1;
                b.rotation.z += 0.08;

                // Monarch fire — expires after distance or too long airborne
                if (b.userData.isMonarchFire && b.userData.age > 80) {
                    igniteRadius(b.position, 8, true);
                    scene.remove(b);
                    lavaBombs.splice(i, 1);
                    continue;
                }

                // Trail spark
                if (Math.random() < 0.5) {
                    createFireParticle(b.position.clone());
                }

                // Firebombs: detect direct cyclops or invader hit
                if (b.userData.isFirebomb) {
                    let hitCyclops = null;
                    for (const c of cyclopses) {
                        if (c.state === 'dying' || c.state === 'dead') continue;
                        const dx = b.position.x - c.mesh.position.x;
                        const dz = b.position.z - c.mesh.position.z;
                        const distXZ = Math.sqrt(dx*dx + dz*dz);
                        if (distXZ < 8 * (c.scale / 2.5) && b.position.y > 5 && b.position.y < 40 * c.scale / 2.5) {
                            hitCyclops = c;
                            break;
                        }
                    }
                    if (hitCyclops) {
                        hitCyclops.onFire = true;
                        hitCyclops.hp -= 80;
                        for (let s = 0; s < 6; s++) createFireParticle(b.position.clone());
                        scene.remove(b);
                        lavaBombs.splice(i, 1);
                        continue;
                    }

                    // Invader direct hit
                    let hitInvader = null;
                    for (const obj of worldObjects) {
                        if (obj.userData.type !== 'invader') continue;
                        if (obj.userData.hp <= 0 || obj.userData.isCorpse) continue;
                        const dx = b.position.x - obj.position.x;
                        const dz = b.position.z - obj.position.z;
                        const distXZ = Math.sqrt(dx*dx + dz*dz);
                        if (distXZ < 1.8 && b.position.y < 5) {
                            hitInvader = obj;
                            break;
                        }
                    }
                    if (hitInvader) {
                        hitInvader.userData.onFire = true;
                        hitInvader.userData.hp -= 50;
                        for (let s = 0; s < 6; s++) createFireParticle(b.position.clone());
                        scene.remove(b);
                        lavaBombs.splice(i, 1);
                        continue;
                    }

                    // Devourer core / leviathan head hit
                    let hitDevourer = null;
                    for (const oct of octopuses) {
                        if (oct.hp <= 0) continue;
                        const dx = b.position.x - oct.pt.x;
                        const dy = b.position.y;
                        const dz = b.position.z - oct.pt.z;
                        if (Math.sqrt(dx*dx + dz*dz) < 40 && dy < 140) {
                            hitDevourer = oct;
                            break;
                        }
                    }
                    if (!hitDevourer) {
                        for (const lev of leviathans) {
                            const dx = b.position.x - lev.headPos.x;
                            const dy = b.position.y - lev.headPos.y;
                            const dz = b.position.z - lev.headPos.z;
                            if (Math.sqrt(dx*dx + dy*dy + dz*dz) < 35) {
                                hitDevourer = { hp: 999, onFire: false, _lev: lev };
                                // Damage leviathan via disruption
                                lev.chompOpen = 0;
                                break;
                            }
                        }
                    }
                    if (hitDevourer && !hitDevourer._lev) {
                        hitDevourer.hp -= 80;
                        hitDevourer.onFire = true;
                        for (let s = 0; s < 8; s++) createFireParticle(b.position.clone());
                        scene.remove(b);
                        lavaBombs.splice(i, 1);
                        continue;
                    } else if (hitDevourer && hitDevourer._lev) {
                        for (let s = 0; s < 8; s++) createFireParticle(b.position.clone());
                        scene.remove(b);
                        lavaBombs.splice(i, 1);
                        continue;
                    }
                }

                if (b.position.y < 0) {
                    if (b.userData.isMonarchFire) {
                        // Fire breath lands — ignite area, no big explosion
                        igniteRadius(b.position, 12, true);
                        for (let s = 0; s < 6; s++) createFireParticle(b.position.clone());
                    } else if (b.userData.isFirebomb) {
                        // No explosion, no shockwave — just spawn fire particles and ignite the area.
                        for (let s = 0; s < 8; s++) createFireParticle(b.position.clone());
                        igniteRadius(b.position, 6, true); // small fire pool, includes fallen logs
                    } else {
                        // Lava bomb impact — bigger explosion + ignition
                        explode(b.position, 14, 0xff7700);
                        igniteRadius(b.position, 16);
                        applyBlast(b.position, 18, 4, 0.5, 100, true);
                    }
                    scene.remove(b);
                    lavaBombs.splice(i, 1);
                }
            }

            // Planet cracker fissures — fade out over time
            for (let fi = crackerFissures.length - 1; fi >= 0; fi--) {
                const f = crackerFissures[fi];
                f.age++;
                if (f.age > f.lifeMax * 0.7) {
                    const fade = 1 - (f.age - f.lifeMax * 0.7) / (f.lifeMax * 0.3);
                    if (f.mesh.material) f.mesh.material.opacity = Math.max(0, fade);
                    if (f.mesh.material) f.mesh.material.transparent = true;
                }
                if (f.age >= f.lifeMax) {
                    scene.remove(f.mesh);
                    f.mesh.geometry.dispose();
                    f.mesh.material.dispose();
                    crackerFissures.splice(fi, 1);
                }
            }

            // Lava streams: growing pool, continuous drops, damage to surroundings
            for (let si = lavaStreams.length - 1; si >= 0; si--) {
                const ls = lavaStreams[si];
                ls.age++;

                // Grow pool radius over time, capped at 30
                const targetRadius = Math.min(30, 1 + ls.age * 0.06);
                if (ls.poolRadius < targetRadius) {
                    ls.poolRadius = targetRadius;
                    ls.pool.scale.set(ls.poolRadius, ls.poolRadius, 1);
                }

                // Pulse glow
                ls.glow.intensity = 2.5 + Math.sin(ls.age * 0.3) * 1.0;

                // Spawn occasional drops (small lava particles dripping from the stream)
                if (ls.age % 6 === 0) {
                    const drop = new THREE.Mesh(
                        new THREE.SphereGeometry(0.3 + Math.random() * 0.3, 6, 5),
                        new THREE.MeshBasicMaterial({ color: Math.random() < 0.5 ? 0xff7700 : 0xff4400 })
                    );
                    drop.position.set(
                        ls.point.x + (Math.random() - 0.5) * 1.5,
                        40 + Math.random() * 20,
                        ls.point.z + (Math.random() - 0.5) * 1.5
                    );
                    drop.userData.vel = new THREE.Vector3(
                        (Math.random() - 0.5) * 0.1,
                        -1.2 - Math.random() * 0.4,
                        (Math.random() - 0.5) * 0.1
                    );
                    scene.add(drop);
                    ls.drops.push(drop);
                }

                // Move drops downward, remove on ground
                for (let di = ls.drops.length - 1; di >= 0; di--) {
                    const drop = ls.drops[di];
                    drop.position.add(drop.userData.vel);
                    if (drop.position.y <= 0.2) {
                        scene.remove(drop);
                        ls.drops.splice(di, 1);
                        // Tiny splatter fire particles
                        if (Math.random() < 0.4) createFireParticle(drop.position.clone());
                    }
                }

                // Damage and ignite objects in the lava pool
                const lsCenter = new THREE.Vector3(ls.point.x, 0, ls.point.z);
                worldObjects.forEach(obj => {
                    if (obj.userData.frozen) return;
                    if (obj.userData.type === 'road') return;
                    const d = obj.position.distanceTo(lsCenter);
                    if (d < ls.poolRadius) {
                        obj.userData.onFire = true;
                        obj.userData.hp -= 0.4;
                    }
                });

                // === LAVA MEETS WATER: both quench each other ===
                let quenched = false;

                // Check rivers: sample their geometry vertices for proximity to lava center
                for (let ri = rivers.length - 1; ri >= 0; ri--) {
                    const river = rivers[ri];
                    const pos = river.geometry.attributes.position;
                    let riverHit = false;
                    for (let v = 0; v < pos.count; v += 3) { // sample every 3rd vertex for speed
                        const vx = pos.getX(v);
                        const vz = pos.getZ(v);
                        const dx = vx - ls.point.x;
                        const dz = vz - ls.point.z;
                        if (Math.sqrt(dx*dx + dz*dz) < ls.poolRadius + 4) {
                            riverHit = true;
                            break;
                        }
                    }
                    if (riverHit) {
                        // Steam explosion visual
                        const steamPos = new THREE.Vector3(ls.point.x, 2, ls.point.z);
                        for (let s = 0; s < 12; s++) {
                            const sp = steamPos.clone().add(new THREE.Vector3(
                                (Math.random()-0.5)*8, Math.random()*4, (Math.random()-0.5)*8
                            ));
                            createFireParticle(sp, true); // smoke/steam
                        }
                        // Dry up the river segment near the lava
                        // Change river color to grey-brown (dried bed)
                        river.material.color.set(0x8b7355);
                        river.material.emissive.set(0x000000);
                        river.material.emissiveIntensity = 0;
                        river.material.opacity = 0.7;
                        river.userData.dried = true;
                        quenched = true;
                    }
                }

                // Check tsunamis: wave front crossing the lava center
                for (let ti = tsunamis.length - 1; ti >= 0; ti--) {
                    const w = tsunamis[ti];
                    const waveDx = Math.abs(w.position - ls.point.x);
                    if (waveDx < ls.poolRadius + 15) {
                        // Steam — massive explosion
                        const steamPos = new THREE.Vector3(ls.point.x, 3, ls.point.z);
                        for (let s = 0; s < 20; s++) {
                            const sp = steamPos.clone().add(new THREE.Vector3(
                                (Math.random()-0.5)*20, Math.random()*8, (Math.random()-0.5)*20
                            ));
                            createFireParticle(sp, true);
                        }
                        // Tsunami dissipates at lava wall
                        w.age = w.lifeMax; // force expire
                        quenched = true;
                    }
                }

                // Also check: volcano lava pools meeting rivers
                // (handled symmetrically — volcano pool burns river same as lava stream)

                // If quenched: rapidly cool the lava stream
                if (quenched) {
                    ls.age = Math.max(ls.age, ls.lifeMax * 0.75); // skip to fade-out phase
                    ls.pool.material.color.lerp(new THREE.Color(0x2a1a0a), 0.1);
                    ls.pool.material.emissive.set(0x000000);
                    ls.glow.intensity *= 0.8;
                    // Stop growing
                    ls.poolRadius = Math.max(1, ls.poolRadius - 0.5);
                    ls.pool.scale.set(ls.poolRadius, ls.poolRadius, 1);
                }

                // Fade stream column out in last 25% of life
                const fadeStart = ls.lifeMax * 0.75;
                if (ls.age > fadeStart) {
                    const fade = 1 - (ls.age - fadeStart) / (ls.lifeMax - fadeStart);
                    ls.stream.material.opacity = 0.85 * fade;
                    ls.glow.intensity *= 0.97;
                }

                // Despawn: remove stream column, move pool to cooledLavaPools for cleanup
                if (ls.age >= ls.lifeMax) {
                    scene.remove(ls.stream);
                    ls.stream.geometry.dispose();
                    ls.stream.material.dispose();
                    scene.remove(ls.glow);
                    ls.drops.forEach(d => scene.remove(d));
                    ls.drops = [];
                    // Cool pool to dark rock and track it separately
                    ls.pool.material.color.set(0x2a1a0a);
                    ls.pool.material.emissive.set(0x000000);
                    ls.pool.material.emissiveIntensity = 0;
                    cooledLavaPools.push(ls.pool); // tracked so reset can clear it
                    lavaStreams.splice(si, 1);
                }
            }

            // Crossbow bolts (invader projectiles)
            for (let i = crossbowBolts.length - 1; i >= 0; i--) {
                const b = crossbowBolts[i];
                b.userData.age++;
                // Track previous position for swept-sphere collision
                const prevPos = b.position.clone();
                b.position.add(b.userData.vel);
                b.userData.vel.y -= b.userData.gravity;
                // Re-aim along velocity
                const lookAtPt = b.position.clone().add(b.userData.vel);
                b.lookAt(lookAtPt);
                // Pulse flame
                if (b.userData.flame) {
                    b.userData.flame.scale.setScalar(0.8 + Math.random() * 0.4);
                }
                // Swept-sphere hit detection along the segment from prevPos → b.position
                let hit = false;
                const stepVec = new THREE.Vector3().subVectors(b.position, prevPos);
                const stepLen = stepVec.length();
                worldObjects.forEach(o => {
                    if (hit) return;
                    if (o.userData.frozen) return;
                    if (o.userData.hp <= 0) return;
                    if (o.userData.type === 'invader') return;
                    const t = o.userData.type;
                    if (t === 'human' || t === 'builder') {
                        // Closest point on segment to person's position
                        const toObj = new THREE.Vector3().subVectors(o.position, prevPos);
                        const dot = stepLen > 0 ? toObj.dot(stepVec) / (stepLen * stepLen) : 0;
                        const tClamp = Math.max(0, Math.min(1, dot));
                        const closest = prevPos.clone().addScaledVector(stepVec, tClamp);
                        if (closest.distanceTo(o.position) < 1.8 && closest.y < 3.5) {
                            o.userData.hp = 0;
                            hit = true;
                        }
                    } else if (t === 'house' && !o.userData.skeleton) {
                        const fp = o.userData.footprint || 8;
                        const dx = b.position.x - o.position.x;
                        const dz = b.position.z - o.position.z;
                        if (Math.abs(dx) < fp / 2 && Math.abs(dz) < fp / 2 && b.position.y < 8) {
                            if (b.userData.flaming) o.userData.onFire = true;
                            o.userData.hp -= 30;
                            hit = true;
                        }
                    }
                });
                if (hit || b.position.y < 0 || b.userData.age > 200) {
                    if (b.userData.flaming && b.position.y < 0) {
                        igniteRadius(b.position, 4);
                    }
                    scene.remove(b);
                    crossbowBolts.splice(i, 1);
                }
            }

            // Cyclops: walking, target seeking, smashing — persistent (no despawn until killed)
            for (let ci = cyclopses.length - 1; ci >= 0; ci--) {
                const c = cyclopses[ci];
                c.age++;
                const S = c.scale;

                // === BURNING ===
                if (c.onFire && c.state !== 'dying' && c.state !== 'dead') {
                    c.burnLevel = Math.min(1, c.burnLevel + 0.003);
                    c.hp -= 1.2;
                    // Char body color toward black
                    c.mesh.traverse(child => {
                        if (child.isMesh && child.material && child.material.color &&
                            child !== c.iris && child !== c.pupil) {
                            child.material.color.lerp(new THREE.Color(0x1a0e08), 0.005);
                        }
                    });
                    // Spawn fire particles around the cyclops
                    if (Math.random() < 0.6) {
                        const fp = c.mesh.position.clone();
                        fp.x += (Math.random() - 0.5) * 8 * S / 2.5;
                        fp.y = 5 * S + Math.random() * 25 * S;
                        fp.z += (Math.random() - 0.5) * 8 * S / 2.5;
                        createFireParticle(fp);
                    }
                    if (Math.random() < 0.2) {
                        const sp = c.mesh.position.clone();
                        sp.y = 35 * S;
                        createFireParticle(sp, true);
                    }
                }

                // === SINGULARITY pulls cyclops in ===
                if (singularityPoint && c.state !== 'dying' && c.state !== 'dead') {
                    const toSing = new THREE.Vector3().subVectors(singularityPoint, c.mesh.position);
                    const d = toSing.length();
                    const strength = Math.max(0.05, 30 / (d + 20));
                    c.mesh.position.add(toSing.normalize().multiplyScalar(strength));
                    if (d < 30) {
                        const sc = Math.max(0.05, d / 30);
                        c.mesh.scale.set(sc, sc, sc);
                    }
                    if (d < 8) {
                        // Consumed
                        despawnCyclops(c);
                        cyclopses.splice(ci, 1);
                        continue;
                    }
                }

                // === TSUNAMI knocks cyclops over ===
                for (const w of tsunamis) {
                    const dx = c.mesh.position.x - w.position;
                    if (Math.abs(dx) < 25) {
                        c.hp -= 4;
                        if (c.state !== 'dying' && c.state !== 'dead' && c.hp <= 0) {
                            // Trigger death
                        }
                    }
                }

                // === DEATH ===
                if (c.hp <= 0 && c.state !== 'dying' && c.state !== 'dead') {
                    c.state = 'dying';
                    c.deathTimer = 0;
                    c.deathAxis = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                    c.eyeLight.intensity = 0;
                    c.iris.material.emissiveIntensity = 0;
                    // Force feet on ground
                    c.mesh.position.y = 0;
                }

                if (c.state === 'dying') {
                    c.deathTimer++;
                    // Topple over: 90 frames of falling, accelerating
                    const t = Math.min(1, c.deathTimer / 90);
                    // Ease-in: starts slow, accelerates as if from gravity
                    const eased = t * t;
                    const angle = eased * Math.PI / 2;
                    c.mesh.rotation.x = c.deathAxis.z * angle;
                    c.mesh.rotation.z = -c.deathAxis.x * angle;
                    // Keep feet anchored to ground level (no bob)
                    c.mesh.position.y = 0;
                    // Limp limbs: arms and legs go slack
                    c.armL.rotation.x *= 0.95;
                    c.armR.rotation.x *= 0.95;
                    c.legL.rotation.x *= 0.95;
                    c.legR.rotation.x *= 0.95;
                    if (t >= 1) {
                        c.state = 'dead';
                        // Final settle — fully horizontal, body resting on the ground.
                        // The mesh group origin is at the cyclops's feet, which after 90° rotation
                        // becomes the rear of the prone body. Shift the group up by half the
                        // perpendicular distance so the body doesn't intersect the ground.
                        // Actually since the rotation moves all body parts to lie laterally at y≈0,
                        // they'll still sit flat. But a sphere 5 units in radius at the original
                        // head position would now have its bottom at y = -5, so sink.
                        // Lift the group by ~scale*5 to compensate.
                        c.mesh.position.y = c.scale * 4;
                    }
                    continue; // skip walking/smashing
                }

                if (c.state === 'dead') {
                    // Just lie there as a corpse — no further updates needed
                    continue;
                }

                // Pulse iris glow
                c.iris.material.emissiveIntensity = 1.5 + Math.sin(c.age * 0.15) * 0.5;

                // === EYE TRACKING ===
                // Aim eyePivot at the current target (or randomly look around if no target)
                const eyeWorld = new THREE.Vector3();
                c.eyePivot.getWorldPosition(eyeWorld);
                let lookAt;
                if (c.target && worldObjects.includes(c.target) && c.target.userData.hp > 0) {
                    lookAt = c.target.position.clone();
                    lookAt.y = c.target.position.y + 1;
                } else {
                    // Slow scanning gaze
                    const t = c.age * 0.012;
                    lookAt = new THREE.Vector3(
                        eyeWorld.x + Math.sin(t) * 30,
                        eyeWorld.y + Math.sin(t * 1.3) * 4,
                        eyeWorld.z + Math.cos(t) * 30
                    );
                }
                // Compute the local direction the eye should face (in cyclops' parent space)
                const localTarget = c.mesh.worldToLocal(lookAt.clone());
                const localEyePos = c.eyePivot.position;
                const dir = new THREE.Vector3().subVectors(localTarget, localEyePos);
                // Compute desired pitch + yaw for the eyePivot
                const desiredYaw = Math.atan2(dir.x, dir.z);
                const desiredPitch = Math.atan2(dir.y, Math.sqrt(dir.x * dir.x + dir.z * dir.z));
                // Clamp eye movement to a believable range (eyes can't roll back into the head)
                const clampedYaw = Math.max(-0.5, Math.min(0.5, desiredYaw));
                const clampedPitch = Math.max(-0.4, Math.min(0.4, -desiredPitch));
                // Smooth toward
                c.eyePivot.rotation.y += (clampedYaw - c.eyePivot.rotation.y) * 0.15;
                c.eyePivot.rotation.x += (clampedPitch - c.eyePivot.rotation.x) * 0.15;

                // Slight head turn following the gaze (much smaller than eye movement)
                c.head.rotation.y = clampedYaw * 0.3;
                c.jaw.rotation.y = clampedYaw * 0.3;

                // Occasional blink: scale eye Y briefly
                const blinkCycle = c.age % 240;
                if (blinkCycle < 6) {
                    c.eyePivot.scale.y = Math.max(0.05, 1 - blinkCycle / 3);
                } else if (blinkCycle < 12) {
                    c.eyePivot.scale.y = Math.min(1, (blinkCycle - 6) / 3);
                } else {
                    c.eyePivot.scale.y = 1;
                }

                if (c.state === 'walking') {
                    // Validate / refresh target
                    if (!c.target || !worldObjects.includes(c.target) || c.target.userData.hp <= 0 || c.target.userData.frozen) {
                        c.target = findCyclopsTarget(c);
                    }

                    if (c.target) {
                        const dx = c.target.position.x - c.mesh.position.x;
                        const dz = c.target.position.z - c.mesh.position.z;
                        const dist = Math.sqrt(dx*dx + dz*dz);

                        // Smash range — for big targets like mountains, account for their footprint
                        const targetRadius = (c.target.userData.footprint || 4) / 2;
                        const smashRange = 14 * S / 2.5 + targetRadius * 0.6;
                        if (dist < smashRange) {
                            // In smash range
                            c.state = 'smashing';
                            c.stateTimer = 0;
                        } else {
                            // Walk forward
                            const stepX = (dx / dist) * c.speed;
                            const stepZ = (dz / dist) * c.speed;
                            c.mesh.position.x += stepX;
                            c.mesh.position.z += stepZ;
                            // Smoothly turn to face direction (lumbering, not snappy)
                            const targetYaw = Math.atan2(stepX, stepZ);
                            let yawDiff = targetYaw - c.mesh.rotation.y;
                            while (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
                            while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
                            c.mesh.rotation.y += yawDiff * 0.1;

                            c.walkPhase += 0.05; // slow ponderous gait

                            // Animate legs: lift one, plant the other
                            const phase = Math.sin(c.walkPhase);
                            c.legL.rotation.x = phase * 0.5;
                            c.legR.rotation.x = -phase * 0.5;
                            // Lift effect via leg rotation; foot world position naturally adjusts
                            // Body bob (subtle for big creature)
                            c.mesh.position.y = Math.abs(phase) * 0.5;
                            // Arm sway opposite legs
                            c.armL.rotation.x = -phase * 0.4;
                            c.armR.rotation.x = phase * 0.25; // smaller because of club weight
                            // Slight torso twist
                            c.head.rotation.z = phase * 0.04;

                            // STOMP: when a leg is at peak forward swing and coming down (phase near +max for L, -max for R, then descending)
                            // Simplified: when foot's world Y is low and previous step was lifted, that's a stomp
                            const footWorldL = new THREE.Vector3();
                            const footWorldR = new THREE.Vector3();
                            c.footL.getWorldPosition(footWorldL);
                            c.footR.getWorldPosition(footWorldR);
                            // Stomp damage applied while foot is planted
                            if (c.legL.rotation.x < 0.1 && c.legL.rotation.x > -0.5) crushUnderFoot(footWorldL, 4 * S);
                            if (c.legR.rotation.x < 0.1 && c.legR.rotation.x > -0.5) crushUnderFoot(footWorldR, 4 * S);
                        }
                    } else {
                        // No target — wander gently
                        c.walkPhase += 0.04;
                        const wx = Math.cos(c.age * 0.005) * 0.05;
                        const wz = Math.sin(c.age * 0.005) * 0.05;
                        c.mesh.position.x += wx;
                        c.mesh.position.z += wz;
                        // Animate legs even while wandering
                        const phase = Math.sin(c.walkPhase);
                        c.legL.rotation.x = phase * 0.3;
                        c.legR.rotation.x = -phase * 0.3;
                        c.mesh.position.y = Math.abs(phase) * 0.3;
                    }

                    // Keep cyclops within world bounds
                    const distFromOrigin = Math.sqrt(c.mesh.position.x ** 2 + c.mesh.position.z ** 2);
                    if (distFromOrigin > WORLD_SIZE - 10) {
                        const back = c.mesh.position.clone().normalize().multiplyScalar(-(distFromOrigin - WORLD_SIZE + 10));
                        c.mesh.position.x += back.x * 0.1;
                        c.mesh.position.z += back.z * 0.1;
                    }
                } else if (c.state === 'smashing') {
                    c.stateTimer++;
                    const t = c.stateTimer;
                    if (t < 35) {
                        // Raise club overhead — rotate right arm back
                        const lift = (t / 35);
                        c.armR.rotation.x = -lift * (Math.PI * 0.85); // sweep up and back
                        c.armR.rotation.z = lift * 0.3;
                        // Open jaw in roar
                        c.jaw.position.y = 28.5 * S - lift * 0.8 * S;
                    } else if (t === 35) {
                        // SLAM!
                        const target = c.target;
                        if (target && worldObjects.includes(target)) {
                            // For big targets (mountains), the club lands at the edge nearest the cyclops,
                            // not at the target's center. Move the smash position toward the cyclops.
                            const targetRadius = (target.userData.footprint || 4) / 2;
                            const smashPos = target.position.clone();
                            if (targetRadius > 5) {
                                const toCyclops = new THREE.Vector3()
                                    .subVectors(c.mesh.position, target.position)
                                    .normalize();
                                smashPos.add(toCyclops.multiplyScalar(targetRadius * 0.8));
                            }
                            // Massive damage radius — proportional to scale.
                            // Don't damage other cyclopses (or self) with the smash.
                            applyBlast(smashPos, 18 * S / 2.5, 6, 0.3, 1500, false, true);
                            // Kill all humans in larger radius
                            worldObjects.forEach(victim => {
                                if (victim.userData.frozen) return;
                                if (victim.position.distanceTo(smashPos) < 22 * S / 2.5) {
                                    if (victim.userData.type === 'human' || victim.userData.type === 'builder') {
                                        victim.userData.hp = 0;
                                    } else if (victim.userData.type === 'tree') {
                                        if (!victim.userData.isFalling && !victim.userData.hasFallen) {
                                            victim.userData.isFalling = true;
                                            victim.userData.fallAxis = new THREE.Vector3(
                                                victim.position.x - smashPos.x,
                                                0,
                                                victim.position.z - smashPos.z
                                            ).normalize();
                                            victim.userData.fallAngle = 0;
                                            victim.userData.hp = 9999;
                                        }
                                    }
                                }
                            });
                            // Visual impact: shockwave
                            explode(smashPos, 35 * S / 2.5, 0x8b6914);
                        }
                    } else if (t < 60) {
                        // Hold the slam pose — arm down, club hits ground
                        c.armR.rotation.x = 0.4;
                        c.armR.rotation.z = 0;
                    } else {
                        // Reset to walking
                        c.armR.rotation.x = 0;
                        c.armR.rotation.z = 0;
                        c.jaw.position.y = 28.5 * S;
                        c.target = null;
                        c.state = 'walking';
                    }
                }
                // No despawn — cyclops persists until manually reset
            }

            // Tsunami movement, animation & lifecycle
            for (let ti = tsunamis.length - 1; ti >= 0; ti--) {
                const w = tsunamis[ti];
                w.age++;
                w.position += w.dir * w.speed;
                w.mesh.position.x = w.position;

                // Animate foam blobs: bob and jiggle to simulate turbulent foam churning
                w.foamBlobs.forEach(blob => {
                    const ud = blob.userData;
                    ud.phase += ud.speed;
                    blob.position.x = ud.basePos.x + Math.sin(ud.phase) * 0.6;
                    blob.position.y = ud.basePos.y + Math.sin(ud.phase * 1.7) * 0.8;
                    blob.position.z = ud.basePos.z + Math.cos(ud.phase * 1.3) * 0.4;
                    // Slight scale pulse so foam appears to billow
                    const s = 1 + Math.sin(ud.phase * 2) * 0.15;
                    blob.scale.set(s, s, s);
                });

                // Animate trail vertex chop (shimmer the surface)
                if (w.trailGeo && w.age % 2 === 0) {
                    const pos = w.trailGeo.attributes.position;
                    for (let i = 0; i < pos.count; i++) {
                        // Pseudo-noise based on vertex index + time
                        const t = w.age * 0.06 + i * 0.5;
                        pos.setZ(i, 0.4 + Math.sin(t) * 0.5 + Math.cos(t * 1.7) * 0.4 + Math.random() * 0.4);
                    }
                    pos.needsUpdate = true;
                    w.trailGeo.computeVertexNormals();
                }

                // Animate trail foam streaks: drift slowly opposite to wave (settling)
                w.trailFoam.forEach(streak => {
                    streak.position.x -= w.dir * 0.15;
                    streak.material.opacity = 0.4 + Math.sin(w.age * 0.05 + streak.userData.basePhase) * 0.2;
                });

                // Spawn airborne spray particles at the wave crest
                if (w.age % 2 === 0 && w.age < w.lifeMax * 0.8) {
                    for (let s = 0; s < 4; s++) {
                        const sprayZ = (Math.random() - 0.5) * WORLD_SIZE * 2.4;
                        const spray = new THREE.Mesh(
                            new THREE.SphereGeometry(0.4 + Math.random() * 0.7, 5, 4),
                            new THREE.MeshBasicMaterial({
                                color: 0xffffff,
                                transparent: true,
                                opacity: 0.7
                            })
                        );
                        spray.position.set(
                            w.position + w.dir * (4 + Math.random() * 6),
                            28 + Math.random() * 8,
                            sprayZ
                        );
                        // Spray flies forward (in wave direction) and up
                        spray.userData = {
                            vel: new THREE.Vector3(
                                w.dir * (0.3 + Math.random() * 0.5),
                                0.4 + Math.random() * 0.5,
                                (Math.random() - 0.5) * 0.2
                            ),
                            life: 1.0,
                            gravity: true
                        };
                        scene.add(spray);
                        fireParticles.push(spray); // reuse fireParticles system for cleanup
                    }
                }

                // Mist/spray cloud trailing the breaking face
                if (w.age % 4 === 0 && w.age < w.lifeMax * 0.85) {
                    const mist = new THREE.Mesh(
                        new THREE.SphereGeometry(2 + Math.random() * 2, 6, 5),
                        new THREE.MeshBasicMaterial({
                            color: 0xe0eef5,
                            transparent: true,
                            opacity: 0.35
                        })
                    );
                    mist.position.set(
                        w.position + w.dir * (8 + Math.random() * 4),
                        12 + Math.random() * 14,
                        (Math.random() - 0.5) * WORLD_SIZE * 2.2
                    );
                    mist.userData = {
                        vel: new THREE.Vector3(w.dir * 0.1, 0.05, 0),
                        life: 1.0
                    };
                    scene.add(mist);
                    fireParticles.push(mist);
                }

                // Fade entire wave near end of life
                if (w.age > w.lifeMax * 0.85) {
                    const fadeRatio = 1 - (w.age - w.lifeMax * 0.85) / (w.lifeMax * 0.15);
                    w.body.material.opacity = 0.88 * fadeRatio;
                    w.inner.material.opacity = 0.55 * fadeRatio;
                    w.foamBlobs.forEach(b => b.material.opacity = 0.95 * fadeRatio);
                    w.trailMat.opacity = 0.65 * fadeRatio;
                }

                // Despawn when wave has fully crossed the world
                if (Math.abs(w.position) > WORLD_SIZE + 80 || w.age > w.lifeMax) {
                    despawnTsunami(w);
                    tsunamis.splice(ti, 1);
                }
            }

            // Debris physics — now with HP, fire, and proper rotation
            for(let i=debris.length-1; i>=0; i--) {
                const d = debris[i];
                const ud = d.userData;

                // Burning debris
                if (ud.onFire) {
                    ud.hp -= 0.5;
                    if (Math.random() < 0.3) createFireParticle(d.position);
                    // Char it
                    if (d.material.color) {
                        d.material.color.lerp(new THREE.Color(0x1a1a1a), 0.02);
                    }
                }

                // Singularity pulls debris too
                if (singularityPoint) {
                    const dir = new THREE.Vector3().subVectors(singularityPoint, d.position);
                    const dist = dir.length();
                    const strength = Math.max(0.08, 60 / (dist + 20));
                    ud.velocity.add(dir.normalize().multiplyScalar(strength));
                    ud.settled = false;
                    if (dist < 30) {
                        const sc = Math.max(0.05, dist/30);
                        d.scale.set(sc, sc, sc);
                    }
                    if (dist < 4) {
                        scene.remove(d);
                        debris.splice(i, 1);
                        continue;
                    }
                }

                // Tsunami sweeps debris along
                for (const w of tsunamis) {
                    const dx = d.position.x - w.position;
                    if (Math.abs(dx) < 25) {
                        const push = Math.sign(w.dir) * 0.6 * (1 - Math.abs(dx)/25);
                        ud.velocity.x += push;
                        ud.velocity.y += 0.15;
                        ud.settled = false;
                    }
                }

                // Tornado sweeps debris into the funnel
                for (const t of tornadoes) {
                    const dx = d.position.x - t.point.x;
                    const dz = d.position.z - t.point.z;
                    const dist = Math.sqrt(dx*dx + dz*dz);
                    if (dist < 80 && t.age < 400) {
                        const tan = new THREE.Vector3(-dz, 0, dx).normalize();
                        const pull = new THREE.Vector3(-dx, 0, -dz).normalize();
                        ud.velocity.add(tan.multiplyScalar(0.4 * (1 - dist/80)));
                        ud.velocity.add(pull.multiplyScalar(0.15 * (1 - dist/80)));
                        if (dist < 40) ud.velocity.y += 0.18;
                        ud.settled = false;
                    }
                }

                if (!ud.settled) {
                    d.position.add(ud.velocity);
                    ud.velocity.y -= gravityConstant;
                    d.rotation.x += ud.angularVel.x;
                    d.rotation.y += ud.angularVel.y;
                    d.rotation.z += ud.angularVel.z;

                    if (d.position.y <= d.geometry.parameters.height/2) {
                        d.position.y = d.geometry.parameters.height/2;
                        ud.velocity.multiplyScalar(0.4);
                        ud.velocity.y *= -0.2;
                        ud.angularVel.multiplyScalar(0.5);
                        if (ud.velocity.length() < 0.1) {
                            ud.settled = true;
                            ud.velocity.set(0,0,0);
                            ud.angularVel.set(0,0,0);
                        }
                    }
                }

                // Settled debris persists; only fades when burned to death
                if (ud.hp <= 0) {
                    if (ud.life > 0) {
                        ud.life -= 0.04;
                        d.material.opacity = ud.life;
                        if (ud.life <= 0) {
                            scene.remove(d);
                            debris.splice(i, 1);
                        }
                    }
                }
            }

            // Fire Particles (and spray particles which use gravity)
            for(let i=fireParticles.length-1; i>=0; i--) {
                const p = fireParticles[i];
                p.position.add(p.userData.vel);
                if (p.userData.gravity) {
                    p.userData.vel.y -= 0.025;
                    // Despawn if hits ground
                    if (p.position.y < 0) p.userData.life = 0;
                }
                p.userData.life -= 0.025;
                p.material.opacity = p.userData.life;
                if (p.userData.life <= 0) { scene.remove(p); fireParticles.splice(i,1); }
            }

            for(let i=worldObjects.length-1; i>=0; i--) {
                const o = worldObjects[i];
                const ud = o.userData;
                ud.lifeTime = (ud.lifeTime || 0) + 1;

                // Skip movement updates for static objects (roads, mountains)
                // But mountains can still be sucked in by black holes.
                if (ud.isStatic) {
                    ud.velocity.set(0,0,0);

                    // Mountains: pulled into singularity
                    if (ud.type === 'mountain' && singularityPoint) {
                        const dirToSing = new THREE.Vector3().subVectors(singularityPoint, o.position);
                        const d = dirToSing.length();
                        // Mountains are massive; use a slower pull rate
                        const strength = Math.max(0.05, 30 / (d + 30));
                        o.position.add(dirToSing.normalize().multiplyScalar(strength));
                        if (d < 50) {
                            // Spaghettify: shrink as approached
                            const sc = Math.max(0.05, d / 50);
                            o.scale.set(sc, sc, sc);
                        }
                        if (d < 8) {
                            scene.remove(o);
                            worldObjects.splice(i, 1);
                            continue;
                        }
                    }

                    if (ud.hp <= 0) {
                        // Mountains crumble dramatically when destroyed
                        if (ud.type === 'mountain') {
                            shatter(o.position, 25, 0x57534e, 1.2);
                            shatter(o.position, 15, 0x3f3a30, 0.9);
                        }
                        scene.remove(o);
                        worldObjects.splice(i, 1);
                    }
                    continue;
                }

                // Frozen corpses: don't run AI, gravity, or boundary logic.
                // BUT we still let the singularity check below pull them in.
                if (ud.frozen) {
                    ud.velocity.set(0, 0, 0);
                    // Singularity check for corpses
                    if (singularityPoint) {
                        const dirToSing = new THREE.Vector3().subVectors(singularityPoint, o.position);
                        const d = dirToSing.length();
                        // Corpses are dragged in like everything else
                        const strength = Math.max(0.08, 60 / (d + 20));
                        o.position.add(dirToSing.normalize().multiplyScalar(strength));
                        if (d < 30) {
                            const sc = Math.max(0.05, d/30);
                            o.scale.set(sc, sc, sc);
                        }
                        if (d < 40) {
                            scene.remove(o);
                            worldObjects.splice(i, 1);
                            continue;
                        }
                    }
                    continue;
                }

                // World boundary
                const distFromCenter = Math.sqrt(o.position.x**2 + o.position.z**2);
                if (distFromCenter > WORLD_SIZE) {
                    const back = o.position.clone().normalize().multiplyScalar(-3);
                    ud.velocity.add(back);
                    if (distFromCenter > WORLD_SIZE + 40) ud.hp = 0;
                }

                // --- HUMAN AI: wander near home, occasionally go inside ---
                if (ud.type === 'human' && !ud.isCorpse && ud.hp > 0 && !ud.onFire && !ud.isFalling) {
                    // Validate home; pick a new one if old home is gone
                    if (!ud.home || !worldObjects.includes(ud.home) || ud.home.userData.hp <= 0 || ud.home.userData.skeleton) {
                        ud.home = findNearestHouse(o.position);
                    }

                    // Hidden-in-house state: invisible for a while, then re-emerge
                    if (ud.hidden) {
                        ud.hideTimer = (ud.hideTimer || 0) - 1;
                        if (ud.hideTimer <= 0 || !ud.home) {
                            // Re-emerge at the door
                            ud.hidden = false;
                            o.visible = true;
                            if (ud.home) {
                                const fp = ud.home.userData.footprint || 8;
                                const doorOffset = new THREE.Vector3(0, 0, fp / 2 + 2);
                                doorOffset.applyEuler(new THREE.Euler(0, ud.home.rotation.y, 0));
                                o.position.set(ud.home.position.x + doorOffset.x, 0, ud.home.position.z + doorOffset.z);
                            }
                            ud.wanderTarget = pickNearbyTarget(o.position, ud.home);
                        }
                    } else {
                        // Decide whether to head home (about every 12 seconds, 30% chance)
                        if (ud.home && (ud.lifeTime % 720) === 0 && Math.random() < 0.3) {
                            ud.goingHome = true;
                            // Walk to door first, then disappear inside
                            const fp = ud.home.userData.footprint || 8;
                            const doorOffset = new THREE.Vector3(0, 0, fp / 2 + 1.5);
                            doorOffset.applyEuler(new THREE.Euler(0, ud.home.rotation.y, 0));
                            ud.wanderTarget = new THREE.Vector3(
                                ud.home.position.x + doorOffset.x,
                                0,
                                ud.home.position.z + doorOffset.z
                            );
                        }

                        // Pick new wander target if reached or stale (and not heading home)
                        if (!ud.goingHome && (!ud.wanderTarget || o.position.distanceTo(ud.wanderTarget) < 1.5 || (ud.lifeTime % 240) === 0)) {
                            ud.wanderTarget = pickNearbyTarget(o.position, ud.home);
                        }

                        const target = ud.wanderTarget;
                        const dx = target.x - o.position.x;
                        const dz = target.z - o.position.z;
                        const distToTarget = Math.sqrt(dx*dx + dz*dz);
                        if (distToTarget > 0.1) {
                            const stepX = (dx / distToTarget) * ud.speed;
                            const stepZ = (dz / distToTarget) * ud.speed;
                            o.position.x += stepX;
                            o.position.z += stepZ;
                            o.rotation.y = Math.atan2(stepX, stepZ);
                            ud.walkPhase += 0.25;
                            o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.15;
                        }

                        // Reached door — go inside
                        if (ud.goingHome && distToTarget < 1) {
                            ud.goingHome = false;
                            ud.hidden = true;
                            ud.hideTimer = 360 + Math.floor(Math.random() * 360); // ~6-12 seconds inside
                            o.visible = false;
                        }

                        // Tether: if too far from home, force return
                        if (ud.home && !ud.goingHome) {
                            const homeDist = o.position.distanceTo(ud.home.position);
                            if (homeDist > 30) {
                                ud.wanderTarget = pickNearbyTarget(ud.home.position, ud.home);
                            }
                        }
                    }
                }

                // --- BUILDER AI: cut trees, build houses, fight invaders ---
                if (ud.type === 'builder' && !ud.isCorpse && ud.hp > 0 && !ud.onFire && !ud.isFalling) {
                    ud.taskTimer = (ud.taskTimer || 0) + 1;

                    // === THREAT DETECTION: invaders + abyssal devourers ===
                    let nearestInvader = null, invaderD = Infinity;
                    worldObjects.forEach(other => {
                        if (other.userData.type !== 'invader') return;
                        if (other.userData.hp <= 0 || other.userData.isCorpse) return;
                        const isAggressive = other.userData.invState === 'attack';
                        const d = other.position.distanceTo(o.position);
                        const threshold = isAggressive ? 50 : 18;
                        if (d < threshold && d < invaderD) {
                            invaderD = d;
                            nearestInvader = other;
                        }
                    });

                    // Also check for devourers — always a top threat
                    let nearestDevourer = null, devourerD = Infinity;
                    octopuses.forEach(oct => {
                        if (oct.hp <= 0) return;
                        const d = oct.pt.distanceTo(o.position);
                        if (d < 150 && d < devourerD) { devourerD = d; nearestDevourer = oct; }
                    });
                    // Also check for leviathans
                    let nearestLev = null, levD = Infinity;
                    leviathans.forEach(lev => {
                        const d = lev.headPos.distanceTo(o.position);
                        if (d < 160 && d < levD) { levD = d; nearestLev = lev; }
                    });

                    const bigThreat = nearestDevourer || nearestLev;
                    if (bigThreat) {
                        if (ud.targetTree) { ud.targetTree.userData.beingChopped = false; ud.targetTree = null; }
                        ud.task = 'attackDevourer';
                        ud.devourerTarget = bigThreat;
                    } else if (nearestInvader) {
                        if (ud.targetTree) { ud.targetTree.userData.beingChopped = false; ud.targetTree = null; }
                        ud.task = 'attackInvader';
                        ud.invaderTarget = nearestInvader;
                    } else if (ud.task === 'attackInvader' || ud.task === 'attackDevourer') {
                        ud.task = 'idle';
                        ud.invaderTarget = null;
                        ud.devourerTarget = null;
                    }

                    // === ATTACK DEVOURER / LEVIATHAN ===
                    if (ud.task === 'attackDevourer') {
                        const oct = ud.devourerTarget;
                        const isLev = leviathans.includes(oct);
                        const isDead = isLev ? false : (oct.hp <= 0);
                        if (!oct || isDead) {
                            ud.task = 'idle';
                            ud.devourerTarget = null;
                        } else {
                            const tx = isLev ? oct.headPos.x : oct.pt.x;
                            const tz = isLev ? oct.headPos.z : oct.pt.z;
                            const targetY = isLev ? oct.headPos.y : 120;
                            const cx = tx, cz = tz;
                            const dx = cx - o.position.x;
                            const dz = cz - o.position.z;
                            const d = Math.sqrt(dx*dx + dz*dz);
                            o.rotation.y = Math.atan2(dx, dz);
                            o.rotation.z = Math.sin(ud.taskTimer * 0.5) * 0.2;
                            if (d > 35) {
                                const stepX = (dx / d) * ud.speed * 1.2;
                                const stepZ = (dz / d) * ud.speed * 1.2;
                                o.position.x += stepX;
                                o.position.z += stepZ;
                                ud.walkPhase += 0.3;
                                o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.18;
                            }
                            if ((ud.taskTimer % 45) === 0) {
                                spawnFirebomb(
                                    new THREE.Vector3(o.position.x, 2, o.position.z),
                                    new THREE.Vector3(cx, targetY, cz)
                                );
                            }
                        }
                        ud.lifeTime = (ud.lifeTime || 0) + 1;
                        continue;
                    }

                    // === ATTACK INVADER ===
                    if (ud.task === 'attackInvader') {
                        const inv = ud.invaderTarget;
                        if (!inv || !worldObjects.includes(inv) || inv.userData.hp <= 0 || inv.userData.isCorpse) {
                            ud.task = 'idle';
                            ud.invaderTarget = null;
                        } else {
                            const ix = inv.position.x;
                            const iz = inv.position.z;
                            const dx = ix - o.position.x;
                            const dz = iz - o.position.z;
                            const d = Math.sqrt(dx*dx + dz*dz);

                            // Builder strikes from a distance — invaders shoot crossbows back
                            const idealDist = 18;
                            if (d > idealDist + 2) {
                                const stepX = (dx / d) * ud.speed * 1.3;
                                const stepZ = (dz / d) * ud.speed * 1.3;
                                o.position.x += stepX;
                                o.position.z += stepZ;
                                o.rotation.y = Math.atan2(stepX, stepZ);
                                ud.walkPhase += 0.3;
                                o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.18;
                            } else if (d < idealDist - 4) {
                                const stepX = -(dx / d) * ud.speed * 1.4;
                                const stepZ = -(dz / d) * ud.speed * 1.4;
                                o.position.x += stepX;
                                o.position.z += stepZ;
                                o.rotation.y = Math.atan2(dx, dz);
                                ud.walkPhase += 0.3;
                                o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.18;
                            } else {
                                o.rotation.y = Math.atan2(dx, dz);
                                o.rotation.z = Math.sin(ud.taskTimer * 0.5) * 0.2;
                                if ((ud.taskTimer % 50) === 0) {
                                    // Throw firebomb at invader (lower target Y since invaders are short)
                                    spawnFirebomb(
                                        new THREE.Vector3(o.position.x, 2, o.position.z),
                                        new THREE.Vector3(ix, 2, iz)
                                    );
                                }
                            }
                        }
                        ud.lifeTime = (ud.lifeTime || 0) + 1;
                        continue;
                    }

                    // Decide what to do
                    if (ud.task === 'idle') {
                        // Decide build type once — commit to it
                        if (ud.lumber >= 2 && !ud.buildingType) {
                            ud.buildingType = Math.random() < 0.3 ? 'skyscraper' : 'house';
                        }
                        const neededLumber = ud.buildingType === 'skyscraper' ? 5 : 3;

                        if (ud.lumber >= neededLumber) {
                            // Have enough — pick a build site and go
                            const angle = Math.random() * Math.PI * 2;
                            const dist = (ud.buildingType === 'skyscraper' ? 20 : 15) + Math.random() * 25;
                            ud.buildSite = new THREE.Vector3(
                                o.position.x + Math.cos(angle) * dist,
                                0,
                                o.position.z + Math.sin(angle) * dist
                            );
                            const distFromOrigin = Math.sqrt(ud.buildSite.x ** 2 + ud.buildSite.z ** 2);
                            if (distFromOrigin > WORLD_SIZE - 12) {
                                ud.buildSite.multiplyScalar((WORLD_SIZE - 12) / distFromOrigin);
                            }
                            ud.task = 'goToBuild';
                        } else {
                            // Need more lumber — find a tree to chop
                            let bestTree = null, bestD = Infinity;
                            worldObjects.forEach(other => {
                                if (other.userData.type !== 'tree') return;
                                if (other.userData.hp <= 0) return;
                                if (other.userData.skeleton) return;
                                if (other.userData.hasFallen) return;
                                if (other.userData.isFalling) return;
                                if (other.userData.beingChopped) return; // claimed by another builder
                                const d = other.position.distanceTo(o.position);
                                if (d < bestD) { bestD = d; bestTree = other; }
                            });
                            if (bestTree) {
                                ud.targetTree = bestTree;
                                bestTree.userData.beingChopped = true; // claim it
                                ud.task = 'goToTree';
                            } else {
                                // No trees — wander a bit
                                if (!ud.wanderTarget || o.position.distanceTo(ud.wanderTarget) < 2) {
                                    const ang = Math.random() * Math.PI * 2;
                                    ud.wanderTarget = new THREE.Vector3(
                                        o.position.x + Math.cos(ang) * 10,
                                        0, o.position.z + Math.sin(ang) * 10
                                    );
                                }
                                walkBuilder(o, ud, ud.wanderTarget);
                            }
                        }
                    } else if (ud.task === 'goToTree') {
                        // Validate target
                        if (!ud.targetTree || !worldObjects.includes(ud.targetTree) ||
                            ud.targetTree.userData.hp <= 0 || ud.targetTree.userData.skeleton ||
                            ud.targetTree.userData.hasFallen || ud.targetTree.userData.isFalling) {
                            // Release claim
                            if (ud.targetTree) ud.targetTree.userData.beingChopped = false;
                            ud.task = 'idle';
                            ud.targetTree = null;
                        } else {
                            const dist = o.position.distanceTo(ud.targetTree.position);
                            if (dist < 2.5) {
                                ud.task = 'chopping';
                                ud.taskTimer = 0;
                            } else {
                                walkBuilder(o, ud, ud.targetTree.position);
                            }
                        }
                    } else if (ud.task === 'chopping') {
                        // Stand still and chop
                        if (ud.targetTree && worldObjects.includes(ud.targetTree)) {
                            // Sway/chop animation
                            o.rotation.z = Math.sin(ud.taskTimer * 0.4) * 0.3;
                            // Damage the tree
                            ud.targetTree.userData.hp -= 0.6;
                            if (ud.targetTree.userData.hp <= 0) {
                                // Tree falls
                                ud.targetTree.userData.isFalling = true;
                                ud.targetTree.userData.fallAxis = new THREE.Vector3(
                                    ud.targetTree.position.x - o.position.x,
                                    0,
                                    ud.targetTree.position.z - o.position.z
                                ).normalize();
                                ud.targetTree.userData.fallAngle = 0;
                                ud.targetTree.userData.hp = 9999; // becomes a fallen log, not destroyed
                                ud.targetTree.userData.beingChopped = false; // release claim
                                ud.lumber += 1;
                                // Now switch to burning the felled log
                                ud.fallenLog = ud.targetTree;
                                ud.targetTree = null;
                                ud.task = 'burnLog';
                                ud.taskTimer = 0;
                                o.rotation.z = 0;
                            }
                        } else {
                            ud.task = 'idle';
                            o.rotation.z = 0;
                        }
                    } else if (ud.task === 'burnLog') {
                        // Trees that have been chopped down should NOT catch fire — they stay
                        // as fallen logs on the ground. Just release the log and go idle.
                        if (ud.fallenLog) {
                            ud.fallenLog.userData.beingChopped = false;
                            ud.fallenLog = null;
                        }
                        ud.task = 'idle';
                    } else if (ud.task === 'goToBuild') {
                        if (ud.buildSite) {
                            const dist = Math.sqrt(
                                (ud.buildSite.x - o.position.x) ** 2 +
                                (ud.buildSite.z - o.position.z) ** 2
                            );
                            if (dist < 2.5) {
                                ud.task = 'building';
                                ud.taskTimer = 0;
                                ud.buildProgress = 0;
                            } else {
                                walkBuilder(o, ud, ud.buildSite);
                            }
                        } else {
                            ud.task = 'idle';
                        }
                    } else if (ud.task === 'building') {
                        // Hammer animation
                        o.rotation.z = Math.sin(ud.taskTimer * 0.5) * 0.2;
                        ud.buildProgress += 1;
                        // Skyscrapers take longer to build (~8 seconds)
                        const buildTime = ud.buildingType === 'skyscraper' ? 480 : 300;
                        if (ud.buildProgress >= buildTime) {
                            // Step back from build site
                            const offset = new THREE.Vector3(o.position.x - ud.buildSite.x, 0, o.position.z - ud.buildSite.z).normalize().multiplyScalar(8);
                            const type = ud.buildingType || 'house';
                            placeObject(type, ud.buildSite);
                            o.position.x = ud.buildSite.x + offset.x;
                            o.position.z = ud.buildSite.z + offset.z;
                            ud.lumber -= (type === 'skyscraper' ? 5 : 3);
                            ud.buildSite = null;
                            ud.buildingType = null; // re-roll on next idle
                            ud.task = 'idle';
                            o.rotation.z = 0;
                        }
                    }
                }

                // --- ANIMAL AI: wander randomly, simple gait animation ---
                if (ud.type === 'animal' && ud.hp > 0 && !ud.isCorpse && !ud.onFire) {
                    ud.wanderTimer = (ud.wanderTimer || 0) + 1;
                    ud.idleTimer = (ud.idleTimer || 0);

                    // Pick a new wander target if none, reached, or stale
                    if (!ud.wanderTarget || o.position.distanceTo(ud.wanderTarget) < 1.5 || ud.wanderTimer > 360) {
                        // Some animals (cows, bears) idle longer
                        if ((ud.species === 'cow' || ud.species === 'bear') && Math.random() < 0.5) {
                            ud.idleTimer = 60 + Math.floor(Math.random() * 180);
                        }
                        const ang = Math.random() * Math.PI * 2;
                        const dist = 8 + Math.random() * 25;
                        ud.wanderTarget = new THREE.Vector3(
                            o.position.x + Math.cos(ang) * dist,
                            0,
                            o.position.z + Math.sin(ang) * dist
                        );
                        // Clamp to world boundary
                        const distFromOrigin = Math.sqrt(ud.wanderTarget.x ** 2 + ud.wanderTarget.z ** 2);
                        if (distFromOrigin > WORLD_SIZE - 5) {
                            ud.wanderTarget.multiplyScalar((WORLD_SIZE - 5) / distFromOrigin);
                        }
                        ud.wanderTimer = 0;
                    }

                    if (ud.idleTimer > 0) {
                        ud.idleTimer--;
                        // Don't move; legs at rest
                        if (ud.legs) ud.legs.forEach(leg => leg.rotation.x = 0);
                    } else {
                        // Walk toward wander target
                        const dx = ud.wanderTarget.x - o.position.x;
                        const dz = ud.wanderTarget.z - o.position.z;
                        const distToTarget = Math.sqrt(dx*dx + dz*dz);
                        if (distToTarget > 0.1) {
                            const stepX = (dx / distToTarget) * ud.speed;
                            const stepZ = (dz / distToTarget) * ud.speed;
                            o.position.x += stepX;
                            o.position.z += stepZ;
                            o.rotation.y = Math.atan2(stepX, stepZ) - Math.PI / 2;
                            // Animate legs - alternating gait
                            ud.walkPhase += ud.species === 'rabbit' ? 0.5 : 0.25;
                            const phase = Math.sin(ud.walkPhase);
                            const phaseB = Math.sin(ud.walkPhase + Math.PI);
                            if (ud.legs && ud.legs.length === 4) {
                                ud.legs[0].rotation.x = phase * 0.4;
                                ud.legs[1].rotation.x = phaseB * 0.4;
                                ud.legs[2].rotation.x = phaseB * 0.4;
                                ud.legs[3].rotation.x = phase * 0.4;
                            }
                            // Body bob — rabbits hop, others trot
                            if (ud.species === 'rabbit') {
                                o.position.y = Math.max(0, Math.sin(ud.walkPhase * 0.5)) * 0.8;
                            } else {
                                o.position.y = Math.abs(phase) * 0.1;
                            }
                        }
                    }
                }

                // --- INVADER AI: wander, stalk, ambush, attack ---
                if (ud.type === 'invader' && ud.hp > 0 && !ud.onFire && !ud.isCorpse) {
                    ud.taskTimer = (ud.taskTimer || 0) + 1;
                    ud.shootCooldown = Math.max(0, (ud.shootCooldown || 0) - 1);

                    // Initialize extended state
                    if (!ud.invState) {
                        ud.invState = 'wander';
                        ud.wanderTarget = null;
                        ud.wanderTimer = 0;
                        ud.stalkOffset = null;   // flanking offset so invaders spread out
                        ud.ambushWait = 0;       // time crouching before charging
                        ud.alertRange = 55 + Math.random() * 30; // each invader has diff detection range
                    }

                    // Helper to step toward a world position
                    function invaderStep(tx, tz) {
                        const dx = tx - o.position.x;
                        const dz = tz - o.position.z;
                        const dist = Math.sqrt(dx*dx + dz*dz);
                        if (dist < 0.5) return dist;
                        const stepX = (dx / dist) * ud.speed;
                        const stepZ = (dz / dist) * ud.speed;
                        o.position.x += stepX;
                        o.position.z += stepZ;
                        o.rotation.y = Math.atan2(stepX, stepZ);
                        ud.walkPhase = (ud.walkPhase || 0) + (ud.mounted ? 0.4 : 0.25);
                        if (ud.mounted) {
                            o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.3;
                            if (ud.horseLegs) {
                                const ph = Math.sin(ud.walkPhase);
                                const ph2 = Math.sin(ud.walkPhase + Math.PI);
                                ud.horseLegs[0].rotation.x = ph * 0.5;
                                ud.horseLegs[1].rotation.x = ph2 * 0.5;
                                ud.horseLegs[2].rotation.x = ph2 * 0.5;
                                ud.horseLegs[3].rotation.x = ph * 0.5;
                            }
                        } else {
                            o.position.y = Math.abs(Math.sin(ud.walkPhase)) * 0.18;
                        }
                        return dist;
                    }

                    // PLAYER TARGETING: survival mode — always highest priority
                    let playerTargetWrapper = null;
                    if (survivalActive && survivalPlayer) {
                        const dToPlayer = survivalPlayer.position.distanceTo(o.position);
                        if (dToPlayer < ud.alertRange) {
                            playerTargetWrapper = {
                                position: survivalPlayer.position,
                                userData: { type: 'player', hp: survivalHp, isCorpse: false }
                            };
                        }
                    }

                    // Find nearest interesting target (builder, house, human)
                    let nearestTarget = null, nearestTargetD = Infinity;
                    worldObjects.forEach(other => {
                        if (other.userData.hp <= 0 || other.userData.frozen || other.userData.isCorpse) return;
                        const isBuilder = other.userData.type === 'builder';
                        const isHouse   = other.userData.type === 'house' && !other.userData.skeleton;
                        const isHuman   = other.userData.type === 'human';
                        if (!isBuilder && !isHouse && !isHuman) return;
                        const d = other.position.distanceTo(o.position);
                        // Weight: close builders > houses > humans
                        const score = d - (isBuilder ? 20 : 0) - (isHuman ? 5 : 0);
                        if (score < nearestTargetD) { nearestTargetD = score; nearestTarget = other; }
                    });

                    const activeTarget = playerTargetWrapper || (nearestTargetD < ud.alertRange ? nearestTarget : null);
                    const distToTarget = activeTarget
                        ? activeTarget.position.distanceTo(o.position)
                        : Infinity;

                    // ---- STATE MACHINE ----
                    if (activeTarget && ud.invState !== 'attack' && ud.invState !== 'ambush') {
                        // Spotted something — transition to stalk or ambush
                        if (distToTarget < 40) {
                            ud.invState = 'ambush';
                            ud.ambushWait = 40 + Math.floor(Math.random() * 80); // 0.7-2s crouch
                            ud.target = activeTarget;
                            // Pick a flanking offset so invaders don't all rush the same point
                            if (!ud.stalkOffset) {
                                const flankAngle = Math.random() * Math.PI * 2;
                                const flankDist = 4 + Math.random() * 10;
                                ud.stalkOffset = new THREE.Vector2(Math.cos(flankAngle) * flankDist, Math.sin(flankAngle) * flankDist);
                            }
                        } else if (distToTarget < ud.alertRange) {
                            ud.invState = 'stalk';
                            ud.target = activeTarget;
                        }
                    }

                    // Lost target — return to wander
                    if (ud.invState !== 'wander' && !activeTarget) {
                        ud.invState = 'wander';
                        ud.target = null;
                        ud.stalkOffset = null;
                        ud.wanderTarget = null;
                    }

                    if (ud.invState === 'wander') {
                        ud.wanderTimer++;
                        // Pick a new wander destination periodically
                        if (!ud.wanderTarget || o.position.distanceTo(ud.wanderTarget) < 3 || ud.wanderTimer > 300) {
                            const ang = Math.random() * Math.PI * 2;
                            const dist = 15 + Math.random() * 40;
                            ud.wanderTarget = new THREE.Vector3(
                                o.position.x + Math.cos(ang) * dist,
                                0,
                                o.position.z + Math.sin(ang) * dist
                            );
                            // Clamp to world
                            const dfo = Math.sqrt(ud.wanderTarget.x**2 + ud.wanderTarget.z**2);
                            if (dfo > WORLD_SIZE - 8) { ud.wanderTarget.multiplyScalar((WORLD_SIZE - 8) / dfo); }
                            ud.wanderTimer = 0;
                        }
                        // Wander at half speed, occasionally pause
                        if (ud.wanderTimer % 120 > 30) { // walk 75% of the time, pause 25%
                            invaderStep(ud.wanderTarget.x, ud.wanderTarget.z);
                        } else {
                            // Idle: look around slightly
                            o.rotation.y += Math.sin(ud.taskTimer * 0.05) * 0.01;
                        }

                    } else if (ud.invState === 'stalk') {
                        // Circle toward target from an angle, staying at medium range
                        const tx = ud.target.position.x + (ud.stalkOffset ? ud.stalkOffset.x : 0);
                        const tz = ud.target.position.z + (ud.stalkOffset ? ud.stalkOffset.y : 0);
                        const d = invaderStep(tx, tz);
                        if (d < 35) {
                            ud.invState = 'ambush';
                            ud.ambushWait = 30 + Math.floor(Math.random() * 60);
                        }

                    } else if (ud.invState === 'ambush') {
                        // Crouch briefly before charging — builds tension
                        ud.ambushWait--;
                        // Lean forward visually
                        o.rotation.x = Math.sin(ud.taskTimer * 0.1) * 0.05;
                        if (ud.ambushWait <= 0) {
                            ud.invState = 'attack';
                        }

                    } else if (ud.invState === 'attack') {
                        // Full charge toward target; shoot when in range
                        o.rotation.x = 0;
                        const tgt = playerTargetWrapper || ud.target;
                        if (!tgt || (!playerTargetWrapper && (!worldObjects.includes(tgt) ||
                            tgt.userData.hp <= 0 || tgt.userData.isCorpse))) {
                            ud.invState = 'wander';
                            ud.target = null;
                            ud.stalkOffset = null;
                        } else {
                            const tx = tgt.position.x;
                            const tz = tgt.position.z;
                            const dx = tx - o.position.x;
                            const dz = tz - o.position.z;
                            const dist = Math.sqrt(dx*dx + dz*dz);
                            const targetType = tgt.userData.type;
                            const isPersonTarget = targetType === 'human' || targetType === 'builder' || targetType === 'player';
                            const shootRange = isPersonTarget ? 22 : 25;

                            if (dist > shootRange) {
                                // Charge at full speed
                                invaderStep(tx, tz);
                            } else {
                                // Shoot
                                o.rotation.y = Math.atan2(dx, dz);
                                if (ud.crossbow) ud.crossbow.rotation.y = 0;
                                if (ud.shootCooldown === 0) {
                                    spawnCrossbowBolt(
                                        new THREE.Vector3(o.position.x, ud.mounted ? 3.4 : 1.4, o.position.z),
                                        new THREE.Vector3(tx, targetType === 'house' ? 4 : 1.8, tz),
                                        targetType === 'house'
                                    );
                                    ud.shootCooldown = isPersonTarget ? 40 : 90;
                                    if (ud.crossbow) ud.crossbow.position.x = (ud.mounted ? 0.5 : 0.4) - 0.15;
                                }
                                if (ud.crossbow && ud.shootCooldown < (isPersonTarget ? 30 : 80)) {
                                    ud.crossbow.position.x = ud.mounted ? 0.5 : 0.4;
                                }
                                // After firing, occasionally reposition (flank to new angle)
                                if (ud.taskTimer % 180 === 0) {
                                    const flankAngle = Math.random() * Math.PI * 2;
                                    ud.stalkOffset = new THREE.Vector2(
                                        Math.cos(flankAngle) * (4 + Math.random() * 8),
                                        Math.sin(flankAngle) * (4 + Math.random() * 8)
                                    );
                                }
                            }
                        }
                    }
                }

                // --- BURNING: panicked running for living entities, char for objects ---
                if (ud.onFire && !ud.skeleton) {
                    // Living things panic and run when on fire
                    const livingType = (ud.type === 'human' || ud.type === 'builder' ||
                                        ud.type === 'invader' || ud.type === 'animal');
                    if (livingType && !ud.isCorpse) {
                        // Initialize panic state once
                        if (ud.panicTimer === undefined) {
                            ud.panicTimer = 0;
                            ud.panicAngle = Math.random() * Math.PI * 2;
                            ud.panicChangeAt = 30 + Math.random() * 60;
                            ud.maxPanicTime = 180 + Math.floor(Math.random() * 90); // 3-4.5 sec
                        }
                        ud.panicTimer++;
                        // Periodically change direction for frantic motion
                        if (ud.panicTimer >= ud.panicChangeAt) {
                            ud.panicAngle += (Math.random() - 0.5) * Math.PI;
                            ud.panicChangeAt = ud.panicTimer + 20 + Math.floor(Math.random() * 50);
                        }
                        // Run faster than normal
                        const runSpeed = (ud.speed || 0.2) * 1.6;
                        const dx = Math.cos(ud.panicAngle) * runSpeed;
                        const dz = Math.sin(ud.panicAngle) * runSpeed;
                        o.position.x += dx;
                        o.position.z += dz;
                        // Clamp to world boundary
                        const dfo = Math.sqrt(o.position.x*o.position.x + o.position.z*o.position.z);
                        if (dfo > WORLD_SIZE - 4) {
                            o.position.x *= (WORLD_SIZE - 4) / dfo;
                            o.position.z *= (WORLD_SIZE - 4) / dfo;
                            // Bounce direction
                            ud.panicAngle += Math.PI;
                        }
                        // Face the running direction (with appropriate offset for animals)
                        if (ud.type === 'animal') {
                            o.rotation.y = Math.atan2(dx, dz) - Math.PI / 2;
                        } else {
                            o.rotation.y = Math.atan2(dx, dz);
                        }
                        // Tilt and stumble — slight body sway for frantic look
                        o.rotation.z = Math.sin(ud.panicTimer * 0.6) * 0.15;
                        // Bob up and down quickly (frantic running)
                        if (ud.type !== 'animal') {
                            o.position.y = Math.abs(Math.sin(ud.panicTimer * 0.6)) * 0.2;
                        }

                        // Charr the body progressively
                        ud.burnLevel = Math.min(1, (ud.burnLevel || 0) + 0.005);
                        applyBurnTint(o, ud.burnLevel);

                        // Spawn fire particles around them
                        if (Math.random() < 0.6) {
                            const fp = o.position.clone();
                            fp.y = 1 + Math.random() * 2.5;
                            createFireParticle(fp);
                        }
                        if (Math.random() < 0.15) {
                            const fp = o.position.clone();
                            fp.y = 2.5 + Math.random() * 1;
                            createFireParticle(fp, true); // smoke
                        }

                        // Drain HP — they die when panic timer expires or HP runs out
                        ud.hp -= 0.5;
                        if (ud.panicTimer >= ud.maxPanicTime || ud.hp <= 0) {
                            ud.hp = 0;
                            // The death block below will turn them into a corpse
                        }
                    } else {
                        // Inanimate objects burn the old way
                        ud.burnLevel = Math.min(1, (ud.burnLevel || 0) + 0.005);
                        applyBurnTint(o, ud.burnLevel);
                        if (ud.type !== 'tree') {
                            const minHp = ud.maxHp * 0.05;
                            if (ud.hp > minHp) ud.hp = Math.max(minHp, ud.hp - 0.6);
                        }
                        // Fire particles — skyscrapers get dramatic climbing fire
                        if (ud.type === 'skyscraper') {
                            const h = ud.totalHeight || 25;
                            // Fire climbs the building proportional to burnLevel
                            const maxFlame = h * ud.burnLevel;
                            const particleCount = 3 + Math.floor(ud.burnLevel * 5);
                            for (let fp = 0; fp < particleCount; fp++) {
                                const fy = Math.random() * maxFlame;
                                const fr = (ud.footprint || 6) * 0.4;
                                const fa = Math.random() * Math.PI * 2;
                                const fpos = o.position.clone().add(new THREE.Vector3(
                                    Math.cos(fa) * fr * (Math.random() * 0.8),
                                    fy,
                                    Math.sin(fa) * fr * (Math.random() * 0.8)
                                ));
                                createFireParticle(fpos, Math.random() < 0.25);
                            }
                            // Windows glow orange-red as building burns
                            if (ud.burnLevel > 0.2) {
                                o.traverse(child => {
                                    if (child.isMesh && child.material && child.material.emissive) {
                                        // Fire glow brightens as it burns
                                        child.material.emissive.set(0xff4400);
                                        child.material.emissiveIntensity = ud.burnLevel * 0.8;
                                    }
                                });
                            }
                        } else {
                            if (Math.random() < 0.5) createFireParticle(o.position.clone().add(new THREE.Vector3(0, 2, 0)));
                            if (Math.random() < 0.2) createFireParticle(o.position.clone().add(new THREE.Vector3(0, 4, 0)), true);
                        }

                        // Spread fire
                        ud.spreadTimer = (ud.spreadTimer || 0) + 1;
                        if (ud.spreadTimer > 40) {
                            worldObjects.forEach(other => {
                                if (other === o) return;
                                if (other.userData.type === 'road') return;
                                if (other.userData.type === 'invader') return;
                                if (other.userData.isCorpse) return;
                                if (other.userData.type === 'tree' && (other.userData.hasFallen || other.userData.isFalling)) return;
                                if (!other.userData.onFire && !other.userData.skeleton && other.position.distanceTo(o.position) < 18) {
                                    if (Math.random() < 0.1) other.userData.onFire = true;
                                }
                            });
                            ud.spreadTimer = 0;
                        }

                        if (ud.burnLevel >= 0.95) {
                            burnedToSkeleton(o);
                        }
                    }
                }

                // --- TORNADO: orbit + lift, no instant kill (loop all active tornadoes) ---
                if (tornadoes.length > 0 && !ud.skeleton) {
                    for (const t of tornadoes) {
                        const dx = o.position.x - t.point.x;
                        const dz = o.position.z - t.point.z;
                        const d = Math.sqrt(dx*dx + dz*dz);

                        if (d < 80 && t.age < 400) {
                            // Tangential swirl (counterclockwise)
                            const tan = new THREE.Vector3(-dz, 0, dx).normalize();
                            // Pull toward center, weaker the closer you are (so they orbit, not collapse)
                            const pull = new THREE.Vector3(-dx, 0, -dz).normalize();
                            const swirlStrength = 0.4 * (1 - d/80);
                            const pullStrength = 0.15 * (1 - d/80);
                            ud.velocity.add(tan.multiplyScalar(swirlStrength));
                            ud.velocity.add(pull.multiplyScalar(pullStrength));
                            // Lift if close
                            if (d < 40) {
                                ud.velocity.y += 0.18;
                            }
                            // Damage from tearing forces
                            if (d < 25) ud.hp -= 1.5;
                            // Humans don't survive being inside a tornado
                            if (((ud.type === 'human' || ud.type === 'builder') && d < 50)) ud.hp = 0;
                        } else if (t.age >= 400 && d < 80) {
                            // Tornado dissipating: throw stuff outward
                            const out = new THREE.Vector3(dx, 0, dz).normalize();
                            ud.velocity.add(out.multiplyScalar(1.2));
                            ud.velocity.y += 0.3;
                        }
                    }
                }

                // --- SINGULARITY: pulls in EVERYTHING, no escape ---
                if (singularityPoint) {
                    const dirToSing = new THREE.Vector3().subVectors(singularityPoint, o.position);
                    const d = dirToSing.length();
                    const strength = Math.max(0.08, 60 / (d + 20));
                    ud.velocity.add(dirToSing.normalize().multiplyScalar(strength));
                    if (d < 30) {
                        const sc = Math.max(0.05, d/30);
                        o.scale.set(sc, sc, sc);
                    }
                    if (((ud.type === 'human' || ud.type === 'builder' || ud.type === 'invader') && d < 40)) {
                        scene.remove(o);
                        worldObjects.splice(i, 1);
                        continue;
                    }
                    if (d < 4) {
                        scene.remove(o);
                        worldObjects.splice(i, 1);
                        continue;
                    }
                }

                // --- TSUNAMI: massive sweeping wave ---
                if (tsunamis.length > 0 && !ud.isStatic) {
                    for (const w of tsunamis) {
                        const dx = o.position.x - w.position;
                        // Object is in the wave's leading impact zone
                        if (Math.abs(dx) < 20) {
                            const intensity = 1 - Math.abs(dx) / 20;
                            // Strong push in wave direction
                            ud.velocity.x += w.dir * 1.4 * intensity;
                            // Lift objects up onto the wave
                            ud.velocity.y += 0.45 * intensity;
                            // Damage from impact
                            ud.hp -= 1.5 * intensity;
                            // Humans drown instantly when struck by a tsunami
                            if ((ud.type === 'human' || ud.type === 'builder')) ud.hp = 0;
                            // Topple trees
                            if (ud.type === 'tree' && !ud.isFalling && !ud.hasFallen && Math.random() < 0.1 * intensity) {
                                ud.isFalling = true;
                                ud.fallAxis = new THREE.Vector3(w.dir, 0, 0);
                                ud.fallAngle = 0;
                            }
                        }
                        // Also drag objects already swept up behind the wave
                        else if (Math.sign(dx) === -Math.sign(w.dir) && Math.abs(dx) < 60) {
                            ud.velocity.x += w.dir * 0.15;
                            // Humans behind the wave are still drowning
                            if ((ud.type === 'human' || ud.type === 'builder')) ud.hp = 0;
                        }
                    }
                }

                // --- FALLING TREES (animated topple) ---
                if (ud.isFalling && ud.type === 'tree') {
                    const targetAngle = Math.PI / 2;
                    if (ud.fallAngle < targetAngle) {
                        ud.fallAngle += 0.02 + ud.fallAngle * 0.05; // accelerating
                        ud.fallAngle = Math.min(ud.fallAngle, targetAngle);
                        // Apply rotation around fallAxis
                        o.rotation.x = ud.fallAxis.z * ud.fallAngle;
                        o.rotation.z = -ud.fallAxis.x * ud.fallAngle;
                        // As the tree falls, lift the trunk base slightly so foliage sits on ground
                        // (foliage thickness ~ 2 units; lerp the lift in from 0 to ~2)
                        o.position.y = 1.5 * (ud.fallAngle / targetAngle);
                    } else {
                        // Fully fallen — settle on ground permanently
                        ud.isFalling = false;
                        ud.hasFallen = true;
                        o.position.y = 1.5;
                    }
                }

                // --- FALLING RUBBLE (split houses) ---
                if (ud.isFalling && ud.type === 'rubble') {
                    if (ud.fallAngle < Math.PI / 2.5) {
                        ud.fallAngle += 0.025;
                        o.rotation.z = ud.fallDir * ud.fallAngle;
                    } else {
                        ud.isFalling = false;
                    }
                }

                // --- PHYSICS (gravity & ground collision) ---
                o.position.add(ud.velocity);
                ud.velocity.y -= gravityConstant;

                if (o.position.y < 0) {
                    if (Math.abs(ud.velocity.y) > 0.6) ud.hp -= Math.abs(ud.velocity.y) * 200;
                    o.position.y = 0;
                    ud.velocity.y = 0;
                    ud.velocity.multiplyScalar(0.7);
                }

                // --- DEATH ---
                if (ud.hp <= 0 && !ud.isCorpse) {
                    if (ud.type === 'human' || ud.type === 'builder') {
                        // Humans don't shatter into debris — they collapse into a corpse
                        // that stays where it fell. Only convert once.
                        // Strip everything, replace with prone body
                        while (o.children.length > 0) o.remove(o.children[0]);
                        const corpseColor = ud.onFire || ud.skeleton ? 0x141414 :
                            (ud.type === 'builder' ? 0xea580c : 0x3b82f6);
                        const corpseMat = new THREE.MeshStandardMaterial({ color: corpseColor, roughness: 0.95 });
                        // Body lying flat
                        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.4, 8), corpseMat);
                        body.rotation.z = Math.PI / 2;
                        body.position.set(0, 0.3, 0);
                        body.castShadow = true;
                        o.add(body);
                        // Head
                        const head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), corpseMat);
                        head.position.set(0.85, 0.3, 0);
                        head.castShadow = true;
                        o.add(head);
                        // Random Y rotation so corpses don't all face the same direction
                        o.rotation.y = Math.random() * Math.PI * 2;
                        // Reset accumulated rotations from blast tumbling
                        o.rotation.x = 0;
                        o.rotation.z = 0;
                        o.scale.set(1, 1, 1);

                        ud.isCorpse = true;
                        ud.frozen = true;
                        ud.velocity.set(0, 0, 0);
                        ud.onFire = false;
                        ud.hp = 1;
                        o.position.y = 0;
                    } else if (ud.type === 'invader') {
                        // Invader slumps down — body slumps forward/sideways, weapons drop.
                        // For mounted invaders, the horse runs off (we just remove it visually)
                        // and the rider tumbles to the ground.
                        while (o.children.length > 0) o.remove(o.children[0]);
                        const charred = ud.onFire;
                        const armorColor = charred ? 0x141414 : 0x44403c;
                        const cloakColor = charred ? 0x141414 : 0x7c2d12;
                        const skinColor = charred ? 0x141414 : 0xc69477;
                        const armorMat = new THREE.MeshStandardMaterial({ color: armorColor, roughness: 0.9 });
                        const cloakMat = new THREE.MeshStandardMaterial({ color: cloakColor, roughness: 0.95 });
                        const skinMat = new THREE.MeshStandardMaterial({ color: skinColor });

                        // Slumped body lying on its side
                        const body = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.5, 0.55, 1.4, 8),
                            armorMat
                        );
                        body.rotation.z = Math.PI / 2;
                        body.position.set(0, 0.45, 0);
                        body.castShadow = true;
                        o.add(body);
                        // Cloak draped over the body
                        const cloak = new THREE.Mesh(
                            new THREE.ConeGeometry(0.7, 1.4, 8, 1, true),
                            cloakMat
                        );
                        cloak.rotation.z = Math.PI / 2;
                        cloak.position.set(-0.4, 0.5, 0.2);
                        cloak.castShadow = true;
                        o.add(cloak);
                        // Head
                        const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), skinMat);
                        head.position.set(0.85, 0.4, 0);
                        head.castShadow = true;
                        o.add(head);
                        // Helmet (rolled off slightly)
                        const helmet = new THREE.Mesh(
                            new THREE.SphereGeometry(0.45, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
                            armorMat
                        );
                        helmet.position.set(1.3, 0.3, 0.2);
                        helmet.rotation.z = Math.PI / 2;
                        helmet.castShadow = true;
                        o.add(helmet);
                        // Crossbow lying next to the body
                        const crossbowMat = new THREE.MeshStandardMaterial({ color: charred ? 0x141414 : 0x44352b, roughness: 1 });
                        const stock = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.15, 0.15), crossbowMat);
                        stock.position.set(0.2, 0.1, -0.7);
                        stock.rotation.y = 0.3;
                        o.add(stock);
                        const bowArm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 1.2), crossbowMat);
                        bowArm.position.set(0.5, 0.1, -0.7);
                        bowArm.rotation.y = 0.3;
                        o.add(bowArm);

                        // Random Y rotation so corpses don't all face the same way
                        o.rotation.y = Math.random() * Math.PI * 2;
                        o.rotation.x = 0;
                        o.rotation.z = 0;
                        o.scale.set(1, 1, 1);

                        ud.isCorpse = true;
                        ud.frozen = true;
                        ud.velocity.set(0, 0, 0);
                        ud.onFire = false;
                        ud.hp = 1;
                        o.position.y = 0;
                    } else if (ud.type === 'animal') {
                        // Animal slumps to the ground, lying on its side
                        while (o.children.length > 0) o.remove(o.children[0]);
                        const scale = ud.scaleVal || 1;
                        const corpseMat = new THREE.MeshStandardMaterial({
                            color: ud.onFire ? 0x141414 : (ud.bodyColor || 0x6b4423),
                            roughness: 0.9
                        });
                        // Body lies flat (long axis along world X, body's "up" axis sideways)
                        const body = new THREE.Mesh(
                            new THREE.BoxGeometry(2.5 * scale, 1.2 * scale, 1.0 * scale),
                            corpseMat
                        );
                        // Roll the body 90° so its original "up" face is now on the ground
                        body.rotation.x = Math.PI / 2;
                        body.position.set(0, 0.5 * scale, 0);
                        body.castShadow = true;
                        o.add(body);
                        // Head fallen to the side
                        const head = new THREE.Mesh(
                            new THREE.SphereGeometry(0.55 * scale, 8, 6),
                            corpseMat
                        );
                        head.position.set(1.4 * scale, 0.4 * scale, 0.2 * scale);
                        head.scale.set(1, 0.8, 1);
                        head.castShadow = true;
                        o.add(head);
                        // Legs splayed out (4 small horizontal cylinders)
                        for (let li = 0; li < 4; li++) {
                            const legZ = (li < 2 ? -0.55 : 0.55) * scale;
                            const legX = ((li % 2 === 0) ? -0.9 : 0.9) * scale;
                            const leg = new THREE.Mesh(
                                new THREE.CylinderGeometry(0.13 * scale, 0.15 * scale, 1.2 * scale, 6),
                                corpseMat
                            );
                            leg.rotation.z = Math.PI / 2; // lying horizontal
                            leg.position.set(legX, 0.15 * scale, legZ + (legZ > 0 ? 0.5 : -0.5) * scale);
                            leg.castShadow = true;
                            o.add(leg);
                        }

                        o.rotation.y = Math.random() * Math.PI * 2;
                        o.rotation.x = 0;
                        o.rotation.z = 0;
                        o.scale.set(1, 1, 1);

                        ud.isCorpse = true;
                        ud.frozen = true;
                        ud.velocity.set(0, 0, 0);
                        ud.onFire = false;
                        ud.hp = 1;
                        o.position.y = 0;
                    } else {
                        if (ud.skeleton) {
                            shatter(o.position, 4, 0x1a1a1a, 0.5);
                        } else if (ud.type === 'house') {
                            shatter(o.position, 22, 0x94a3b8, 1.2);
                        } else if (ud.type === 'skyscraper') {
                            // Big building collapses with lots of debris
                            shatter(o.position, 40, 0x6b7280, 2.0);
                            shatter(o.position, 20, 0x60a5fa, 1.5);
                        } else if (ud.type === 'rubble') {
                            shatter(o.position, 10, 0x94a3b8, 0.8);
                        } else if (ud.type === 'tree') {
                            shatter(o.position, 8, 0x78350f, 0.6);
                        } else if (ud.type === 'road') {
                            shatter(o.position, 6, 0x334155, 0.4);
                        }
                        scene.remove(o);
                        worldObjects.splice(i, 1);
                    }
                }
            }

            renderer.render(scene, camera);
        }

        function setupUI() {
            const buildIds = ['house', 'skyscraper', 'tree', 'human', 'builder', 'invader', 'animal', 'river', 'mountain', 'eraser'];
            const destroyIds = ['fire', 'vortex', 'quake', 'tsunami', 'volcano', 'lavaflood', 'napalm', 'cluster', 'nuke', 'blackhole', 'meteor', 'cracker', 'leviathan', 'kraken'];
            const ids = [...buildIds, ...destroyIds];

            ids.forEach(id => {
                const el = document.getElementById('btn-' + id);
                if (el) el.onclick = () => {
                    if (currentBrush === id) {
                        // Same tool clicked again — deselect
                        currentBrush = null;
                        el.classList.remove('active');
                        showMessage('Deselected');
                        return;
                    }
                    currentBrush = id;
                    document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
                    el.classList.add('active');
                    const label = el.querySelector('span:not(.icon)')?.innerText || id;
                    let hint = '';
                    if (id === 'river') hint = ' · click and drag to draw';
                    if (id === 'volcano') hint = ' · tap to erupt';
                    if (id === 'builder') hint = ' · cuts trees and builds houses';
                    if (id === 'eraser') hint = ' · tap an object to erase';
                    if (id === 'invader') hint = ' · charges your village';
                    if (id === 'animal') hint = ' · random species, wanders';
                    showMessage('Selected: ' + label + hint);
                };
            });

            // Tab switching
            document.querySelectorAll('.tab').forEach(tab => {
                tab.onclick = () => {
                    const target = tab.dataset.tab;
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    document.querySelectorAll('.tray').forEach(tr => tr.classList.remove('active'));
                    document.getElementById('tray-' + target).classList.add('active');
                };
            });

            // Collapse/expand toolbar
            const toolbar = document.getElementById('toolbar');
            const handle = document.getElementById('handle');
            handle.onclick = () => toolbar.classList.toggle('hidden');
            document.getElementById('btn-toggle').onclick = () => toolbar.classList.toggle('hidden');

            // Generate Terrain
            document.getElementById('btn-generate').onclick = () => generateTerrain();

            // Random village: clears the world and builds a generic village
            document.getElementById('btn-village').onclick = () => generateRandomVillage();

            // Day/Night toggle: cycles Auto → Day → Night → Auto
            const dayNightBtn = document.getElementById('btn-daynight');
            dayNightBtn.onclick = () => {
                if (dayNightMode === 'auto') {
                    dayNightMode = 'day';
                    dayPhase = 0.5; // noon
                    dayNightBtn.innerText = '☀️';
                    showMessage('Day (locked)');
                } else if (dayNightMode === 'day') {
                    dayNightMode = 'night';
                    dayPhase = 0.0; // midnight
                    dayNightBtn.innerText = '🌙';
                    showMessage('Night (locked)');
                } else {
                    dayNightMode = 'auto';
                    dayNightBtn.innerText = '🔄';
                    showMessage('Day/Night auto cycle');
                }
            };

            // Exit Simulator → return to mode select
            document.getElementById('btn-exit-sim').onclick = () => {
                gameMode = 'menu';
                document.getElementById('header').style.display = 'none';
                document.getElementById('toolbar').style.display = 'none';
                document.getElementById('mode-screen').classList.remove('hidden');
            };

            // Reset button
            document.getElementById('btn-clear').onclick = () => {
                worldObjects.forEach(o => scene.remove(o));
                worldObjects = [];
                debris.forEach(d => scene.remove(d));
                debris = [];
                fireParticles.forEach(f => scene.remove(f));
                fireParticles = [];
                lavaBombs.forEach(b => scene.remove(b));
                lavaBombs = [];
                crossbowBolts.forEach(b => scene.remove(b));
                crossbowBolts = [];
                lavaStreams.forEach(ls => {
                    if (ls.pool) scene.remove(ls.pool);
                    if (ls.stream) scene.remove(ls.stream);
                    if (ls.glow) scene.remove(ls.glow);
                    if (ls.drops) ls.drops.forEach(d => scene.remove(d));
                });
                lavaStreams = [];
                cooledLavaPools.forEach(p => { scene.remove(p); if (p.geometry) p.geometry.dispose(); if (p.material) p.material.dispose(); });
                cooledLavaPools = [];
                crackerFissures.forEach(f => { scene.remove(f.mesh); });
                crackerFissures = [];
                octopuses.forEach(o => {
                    scene.remove(o.group);
                    if (o.portalGroup) scene.remove(o.portalGroup);
                    o.tentacles.forEach(tnd => scene.remove(tnd.group));
                });
                octopuses = [];
                leviathans.forEach(l => {
                    scene.remove(l.headGroup);
                    l.segGroups.forEach(sg => scene.remove(sg));
                });
                leviathans = [];
                if (monarchInstance) {
                    if (monarchInstance.group) scene.remove(monarchInstance.group);
                    monarchInstance = null;
                }
                krakens.forEach(k => {
                    scene.remove(k.portalGroup);
                    if (k.portalLight) scene.remove(k.portalLight);
                    if (k.groundChunk) scene.remove(k.groundChunk.group);
                    k.tentacles.forEach(t => { if (t.target) t.target.userData.beingGrabbed = false; });
                });
                krakens = [];
                despawnAllTornadoes();
                despawnAllTsunamis();
                despawnAllVolcanoes();
                despawnAllCyclopses();
                clearRivers();
                // Keep grass — just re-spawn fresh to remove any burn marks
                clearGrass();
                spawnGrass();
                singularityPoint = null;
                residentSpawnTimer = 0;
                clearMultiTargets();
                showMessage("Simulation Reset");
            };

            // Escape key cancels multi-selection
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape' && multiTargets.length > 0) {
                    clearMultiTargets();
                    showMessage('Selection cleared');
                }
            });
        }

        // ===== CONSTRUCTION SIMULATION MODE =====
        let constrSites = [];    // active building sites
        let constrVehicles = []; // cranes, trucks, workers
        let constrSpeed = 1;
        let constrActive = false;
        let constrAnimFrame = 0;

        function setConstructionSpeed(s) { constrSpeed = s; }

        // Construction placement mode
        let constrPlacing = false;
        let constrPlaceCursor = null;

        function startConstrPlacement() {
            constrPlacing = true;
            // Create a glowing cursor disc on the ground
            constrPlaceCursor = new THREE.Mesh(
                new THREE.CircleGeometry(8, 32),
                new THREE.MeshBasicMaterial({ color: 0x22cc44, transparent: true, opacity: 0.45 })
            );
            constrPlaceCursor.rotation.x = -Math.PI / 2;
            constrPlaceCursor.position.y = 0.3;
            scene.add(constrPlaceCursor);
            updateConstrStatus('Click on the ground to place your building...');
        }

        function cancelConstrPlacement() {
            constrPlacing = false;
            if (constrPlaceCursor) { scene.remove(constrPlaceCursor); constrPlaceCursor = null; }
        }

        // Wire placement click into the main pointer handler
        function handleConstrPointerDown(e) {
            if (!constrActive || gameMode !== 'construction') return;
            if (constrPlacing) {
                const pt = screenToGround(e);
                if (!pt) return;
                cancelConstrPlacement();
                addConstructionSiteAt(pt.x, pt.z);
                return;
            }
            // Check if clicking near a completed building for tour
            checkConstrClick(e);
        }

        function handleConstrPointerMove(e) {
            if (!constrPlacing || !constrPlaceCursor || gameMode !== 'construction') return;
            const pt = screenToGround(e);
            if (pt) {
                constrPlaceCursor.position.x = pt.x;
                constrPlaceCursor.position.z = pt.z;
            }
        }

        // ── CLEAR SCENE: removes all sim objects so modes don't bleed into each other ──
        function clearScene() {
            // World objects (buildings, trees, people…)
            worldObjects.forEach(o => scene.remove(o));
            worldObjects = [];
            debris.forEach(d => scene.remove(d));
            debris = [];
            fireParticles.forEach(f => scene.remove(f));
            fireParticles = [];
            lavaBombs.forEach(b => scene.remove(b));
            lavaBombs = [];
            if (typeof crossbowBolts !== 'undefined') { crossbowBolts.forEach(b => scene.remove(b)); crossbowBolts = []; }
            lavaStreams.forEach(ls => {
                if (ls.pool) scene.remove(ls.pool);
                if (ls.stream) scene.remove(ls.stream);
                if (ls.glow) scene.remove(ls.glow);
                if (ls.drops) ls.drops.forEach(d => scene.remove(d));
            });
            lavaStreams = [];
            cooledLavaPools.forEach(p => { scene.remove(p); if (p.geometry) p.geometry.dispose(); if (p.material) p.material.dispose(); });
            cooledLavaPools = [];
            crackerFissures.forEach(f => { if (f.mesh) scene.remove(f.mesh); });
            crackerFissures = [];
            leviathans.forEach(l => { scene.remove(l.headGroup); l.segGroups.forEach(sg => scene.remove(sg)); });
            leviathans = [];
            krakens.forEach(k => {
                scene.remove(k.portalGroup);
                if (k.portalLight) scene.remove(k.portalLight);
                if (k.groundChunk) scene.remove(k.groundChunk.group);
                k.tentacles.forEach(t => { if (t.target) t.target.userData.beingGrabbed = false; });
            });
            krakens = [];
            octopuses = [];
            if (monarchInstance) { if (monarchInstance.group) scene.remove(monarchInstance.group); monarchInstance = null; }
            despawnAllTornadoes();
            despawnAllTsunamis();
            despawnAllVolcanoes();
            if (typeof despawnAllCyclopses === 'function') despawnAllCyclopses();
            clearRivers();
            clearGrass();
            spawnGrass();
            singularityPoint = null;
            residentSpawnTimer = 0;
            if (typeof clearMultiTargets === 'function') clearMultiTargets();
        }

        function enterConstruction() {
            clearScene();         // wipe any sim/survival objects
            constrActive = true;
            constrSites = [];
            constrVehicles = [];
            constrAnimFrame = 0;

            camera.position.set(0, 90, 80);
            camera.lookAt(0, 0, 0);
            controls.enabled = false;
            initFlyCamera();

            // Wire placement pointer events
            renderer.domElement.addEventListener('pointerdown', handleConstrPointerDown);
            renderer.domElement.addEventListener('pointermove', handleConstrPointerMove);
            // Tour click handler — click near a finished building to select it
            renderer.domElement.addEventListener('pointerdown', checkConstrClick);

            addConstructionSiteAt(0, 0);
            addConstructionSiteAt(35, -20);
            updateConstrStatus('Sites ready — trucks arriving...');
        }

        function exitConstruction() {
            constrActive = false;
            cancelConstrPlacement();
            renderer.domElement.removeEventListener('pointerdown', handleConstrPointerDown);
            renderer.domElement.removeEventListener('pointermove', handleConstrPointerMove);
            renderer.domElement.removeEventListener('pointerdown', checkConstrClick);
            if (tourActive) stopTour();
            constrSites.forEach(s => {
                s.meshes.forEach(m => scene.remove(m));
                s.scaffoldMeshes.forEach(m => scene.remove(m));
                if (s.ghost) scene.remove(s.ghost);
                // Clean up any waiting pallets
                if (s.waitingPallets) s.waitingPallets.forEach(p => { if (p.group) scene.remove(p.group); });
            });
            constrVehicles.forEach(v => { if (v && v.group) scene.remove(v.group); });
            constrSites = [];
            constrVehicles = [];
        }

        function updateConstrStatus(msg) {
            const el = document.getElementById('constr-status');
            if (el) el.textContent = msg;
        }

        const C = {
            concrete:   () => new THREE.MeshStandardMaterial({ color: 0xc8bfae, roughness: 0.9 }),
            brick:      () => new THREE.MeshStandardMaterial({ color: 0xb85f3a, roughness: 0.85 }),
            steel:      () => new THREE.MeshStandardMaterial({ color: 0x6b7a8d, roughness: 0.4, metalness: 0.7 }),
            glass:      () => new THREE.MeshStandardMaterial({ color: 0x7ecfed, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.75 }),
            wood:       () => new THREE.MeshStandardMaterial({ color: 0x9c6b3c, roughness: 0.9 }),
            yellow:     () => new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.6, metalness: 0.3 }),
            red:        () => new THREE.MeshStandardMaterial({ color: 0xcc2200, roughness: 0.7 }),
            dark:       () => new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }),
            orange:     () => new THREE.MeshStandardMaterial({ color: 0xe87820, roughness: 0.7 }),
            skin:       () => new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.8 }),
            white:      () => new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.7 }),
            cream:      () => new THREE.MeshStandardMaterial({ color: 0xf5ecd7, roughness: 0.8 }),
            chrome:     () => new THREE.MeshStandardMaterial({ color: 0xd0d8e0, roughness: 0.1, metalness: 0.9 }),
        };

        function addConstructionSite() {
            // When called without position (from auto-spawn), pick a free spot
            const spread = 80;
            let cx = (Math.random()-0.5)*spread;
            let cz = (Math.random()-0.5)*spread;
            constrSites.forEach(s => {
                if (Math.sqrt((cx-s.cx)**2+(cz-s.cz)**2) < 45) { cx += 50; }
            });
            addConstructionSiteAt(cx, cz);
        }

        function addConstructionSiteAt(cx, cz) {
            const floors = 4 + Math.floor(Math.random() * 8);
            const width  = 8 + Math.random() * 6;
            const depth  = 8 + Math.random() * 6;
            const floorH = 3.5;
            const isSkyscraper = floors > 8;
            const hasBalcony = !isSkyscraper && Math.random() < 0.55;

            const site = {
                cx, cz, width, depth, floorH, floors, isSkyscraper, hasBalcony,
                meshes: [],
                scaffoldMeshes: [],
                ghost: null,
                phase: 'foundation',
                currentFloor: 0,
                brickProgress: 0,
                timer: 0,
                craneId: null,
                truckId: null,
                workerIds: [],
                done: false,
                // Interior progress
                interiorStep: 0,
                interiorTimer: 0,
            };

            const ghost = new THREE.Mesh(
                new THREE.BoxGeometry(width, floors*floorH, depth),
                new THREE.MeshStandardMaterial({ color: 0x88aabb, transparent: true, opacity: 0.15, side: THREE.DoubleSide })
            );
            ghost.position.set(cx, floors*floorH/2, cz);
            scene.add(ghost);
            site.ghost = ghost;

            spawnTruck(site);
            spawnCrane(site);
            const nw = 2 + Math.floor(Math.random()*2);
            for (let i = 0; i < nw; i++) spawnWorker(site);

            constrSites.push(site);
            updateConstrStatus(`Building ${constrSites.length} site${constrSites.length>1?'s':''} active`);
        }

        function spawnTruck(site) {
            const g = new THREE.Group();
            // Cab
            const cab = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.8, 4.5), C.red());
            cab.position.set(0, 1.5, 0); cab.castShadow = true; g.add(cab);
            // Cargo bed
            const bed = new THREE.Mesh(new THREE.BoxGeometry(3.5, 1.4, 7), C.red());
            bed.position.set(0, 0.8, 5); bed.castShadow = true; g.add(bed);
            // Cargo (index 2 — manipulated during unload)
            const cargo = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 6), C.concrete());
            cargo.position.set(0, 1.9, 5); g.add(cargo);
            // Wheels
            for (const [wx,wy,wz] of [[-2,0.45,-2],[2,0.45,-2],[-2,0.45,7],[2,0.45,7]]) {
                const w = new THREE.Mesh(new THREE.CylinderGeometry(0.6,0.6,0.5,10), C.dark());
                w.rotation.z = Math.PI/2; w.position.set(wx,wy,wz); g.add(w);
            }
            // Windscreen
            const ws = new THREE.Mesh(new THREE.BoxGeometry(3.3,1.2,0.15), C.glass());
            ws.position.set(0,2.2,-2.3); g.add(ws);

            const startAngle = Math.random()*Math.PI*2;
            g.position.set(site.cx+Math.cos(startAngle)*110, 0, site.cz+Math.sin(startAngle)*110);
            scene.add(g);

            const truck = {
                group: g, type: 'truck', site,
                phase: 'approach', speed: 0.35, angle: startAngle, timer: 0,
                loaded: true, departAngle: startAngle + Math.PI,
            };
            constrVehicles.push(truck);
            site.truckId = constrVehicles.length - 1;
            return truck;
        }

        function spawnCrane(site) {
            const g = new THREE.Group();
            const craneX = site.cx + site.width/2 + 6;
            const craneZ = site.cz;
            const towerH = 55;

            // Base
            const base = new THREE.Mesh(new THREE.BoxGeometry(5, 1.2, 5), C.yellow());
            base.position.y = 0.6; g.add(base);
            // Base outriggers
            for (const [bx,bz] of [[3,0],[-3,0],[0,3],[0,-3]]) {
                const out = new THREE.Mesh(new THREE.BoxGeometry(3.5,0.4,0.8), C.yellow());
                out.position.set(bx,0.4,bz);
                if (Math.abs(bz)>0) out.rotation.y = Math.PI/2;
                g.add(out);
            }
            // Mast (lattice look via 4 corner tubes)
            for (const [mx,mz] of [[0.5,0.5],[-0.5,0.5],[0.5,-0.5],[-0.5,-0.5]]) {
                const col = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,towerH,6), C.yellow());
                col.position.set(mx, towerH/2+1.2, mz); col.castShadow = true; g.add(col);
            }
            // Cross braces every 5 units
            for (let i = 0; i < Math.floor(towerH/5); i++) {
                const y = 1.2 + i*5 + 2.5;
                const br1 = new THREE.Mesh(new THREE.BoxGeometry(1.4,0.12,0.12), C.yellow());
                br1.position.set(0,y,0.5); g.add(br1);
                const br2 = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.12,1.4), C.yellow());
                br2.position.set(0.5,y,0); g.add(br2);
            }
            // Operator cab
            const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2,1.9,2.2), C.yellow());
            cab.position.set(0,towerH+1.2,0); g.add(cab);
            const cabWin = new THREE.Mesh(new THREE.BoxGeometry(2,1.2,0.12), C.glass());
            cabWin.position.set(0,towerH+1.3,-1.16); g.add(cabWin);

            // Jib pivot group (rotates)
            const jibPivot = new THREE.Group();
            jibPivot.position.y = towerH+2.2;
            g.add(jibPivot);

            // Main jib
            const jib = new THREE.Mesh(new THREE.BoxGeometry(40,0.6,0.8), C.yellow());
            jib.position.x = 14; jibPivot.add(jib);
            // Jib diagonal supports
            const js1 = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,22,5), C.yellow());
            js1.position.set(8,4,0); js1.rotation.z = Math.PI/6; jibPivot.add(js1);
            const js2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,14,5), C.yellow());
            js2.position.set(25,2.5,0); js2.rotation.z = Math.PI/5; jibPivot.add(js2);
            // Counter jib
            const cJib = new THREE.Mesh(new THREE.BoxGeometry(14,0.6,0.8), C.yellow());
            cJib.position.x = -7; jibPivot.add(cJib);
            const cw = new THREE.Mesh(new THREE.BoxGeometry(3,2,2), C.dark());
            cw.position.set(-12,0,0); jibPivot.add(cw);

            // Trolley (slides along jib)
            const trolley = new THREE.Mesh(new THREE.BoxGeometry(2,1.2,1.5), C.steel());
            trolley.position.set(8,-1,0); jibPivot.add(trolley);

            // Cable group (moves with trolley)
            const cableGroup = new THREE.Group();
            cableGroup.position.set(8,-1,0);
            jibPivot.add(cableGroup);
            const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,14,6), C.steel());
            cable.position.y = -7; cableGroup.add(cable);
            const hook = new THREE.Mesh(new THREE.SphereGeometry(0.4,8,6), C.steel());
            hook.position.y = -14.5; cableGroup.add(hook);
            // Hook frame
            const hookBar = new THREE.Mesh(new THREE.BoxGeometry(0.6,1.2,0.15), C.steel());
            hookBar.position.y = -14; cableGroup.add(hookBar);

            // Load block (material pallet being hoisted)
            const loadPallet = new THREE.Group();
            loadPallet.position.y = -16;
            cableGroup.add(loadPallet);
            const palletBase = new THREE.Mesh(new THREE.BoxGeometry(2.8,0.25,2.8), C.wood());
            loadPallet.add(palletBase);
            const loadTop = new THREE.Mesh(new THREE.BoxGeometry(2.4,1.1,2.4), C.brick());
            loadTop.position.y = 0.65; loadPallet.add(loadTop);
            // Straps
            for (const sx of [-1,1]) {
                const strap = new THREE.Mesh(new THREE.BoxGeometry(0.1,1.5,2.6), C.orange());
                strap.position.set(sx,0.4,0); loadPallet.add(strap);
            }

            g.position.set(craneX, 0, craneZ);
            scene.add(g);

            const crane = {
                group: g, type: 'crane', site,
                jibPivot, trolley, cableGroup, loadPallet,
                jibAngle: 0, trolleyOffset: 8,
                hoistY: -16, targetHoistY: -16,
                trolleyTarget: 8,
                phase: 'working', // working → lowerLoad → jibHome → dismantle → drive
                timer: 0,
                dismantleStep: 0,
                towerH,
                craneX, craneZ,
                departAngle: Math.random()*Math.PI*2,
            };
            constrVehicles.push(crane);
            site.craneId = constrVehicles.length - 1;
            return crane;
        }

        function spawnWorker(site) {
            const g = new THREE.Group();
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,1.2,8), C.orange());
            body.position.y = 0.9; g.add(body);
            const head = new THREE.Mesh(new THREE.SphereGeometry(0.32,8,6), C.skin());
            head.position.y = 1.85; g.add(head);
            const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.42,0.38,0.25,10), C.yellow());
            hat.position.y = 2.06; g.add(hat);
            const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.55,0.55,0.08,10), C.yellow());
            hatBrim.position.y = 1.98; g.add(hatBrim);
            for (const side of [-1,1]) {
                const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,0.9,6), C.orange());
                arm.position.set(side*0.55,1.1,0); arm.rotation.z = side*0.4; g.add(arm);
            }
            for (const side of [-1,1]) {
                const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.14,0.14,0.9,6), C.dark());
                leg.position.set(side*0.2,0.25,0); g.add(leg);
            }
            // Tool in hand (small wrench shape)
            const tool = new THREE.Mesh(new THREE.BoxGeometry(0.1,0.5,0.1), C.steel());
            tool.position.set(-0.9,0.9,0.2); g.add(tool);

            const ang = Math.random()*Math.PI*2;
            const r = site.width/2 + 2 + Math.random()*3;
            g.position.set(site.cx+Math.cos(ang)*r, 0, site.cz+Math.sin(ang)*r);
            scene.add(g);

            const worker = {
                group: g, type: 'worker', site,
                walkAngle: ang, walkRadius: r,
                walkSpeed: 0.012+Math.random()*0.008,
                taskTimer: 0, armPhase: Math.random()*Math.PI*2,
                phase: 'working', // working → walkOff
                departAngle: Math.random()*Math.PI*2,
                departDist: 0,
            };
            constrVehicles.push(worker);
            site.workerIds.push(constrVehicles.length - 1);
            return worker;
        }

        function removeScaffolding(site) {
            // Animate scaffold removal: fade out then delete
            site.scaffoldMeshes.forEach(m => {
                if (!m || !m.material) return;
                // Make transparent first
                if (!Array.isArray(m.material)) {
                    m.material = m.material.clone();
                    m.material.transparent = true;
                }
            });
            // Remove in staggered steps over 2 seconds
            const total = site.scaffoldMeshes.length;
            site.scaffoldMeshes.forEach((m, idx) => {
                setTimeout(() => {
                    scene.remove(m);
                    if (m.geometry) m.geometry.dispose();
                }, 300 + idx * (1500 / Math.max(1, total)));
            });
            site.scaffoldMeshes = [];
        }

        function updateConstruction() {
            if (!constrActive || gameMode !== 'construction') return;
            for (let step = 0; step < constrSpeed; step++) _tickConstruction();
        }

        function _tickConstruction() {
            const frame = constrAnimFrame++;
            const allDone = constrSites.length > 0 && constrSites.every(s => s.done);

            constrSites.forEach(site => {
                if (site.done) return;
                site.timer++;
                const t = site.timer;
                const fw = site.width, fd = site.depth, fh = site.floorH;
                const cx = site.cx, cz = site.cz;

                if (site.phase === 'foundation') {
                    if (t === 1) {
                        // Excavation marks
                        const exc = new THREE.Mesh(new THREE.BoxGeometry(fw+3,0.3,fd+3),
                            new THREE.MeshStandardMaterial({color:0x5c3d1e,roughness:1}));
                        exc.position.set(cx,-0.1,cz); scene.add(exc); site.meshes.push(exc);
                        // Shuttering boards around edge (temporary)
                        for (const [wx,wz,rot] of [[cx,cz-fd/2-1.2,0],[cx,cz+fd/2+1.2,0],[cx-fw/2-1.2,cz,Math.PI/2],[cx+fw/2+1.2,cz,Math.PI/2]]) {
                            const shutt = new THREE.Mesh(new THREE.BoxGeometry(fw+2.6,0.8,0.25), C.wood());
                            shutt.position.set(wx,0.4,wz); shutt.rotation.y=rot;
                            scene.add(shutt); site.scaffoldMeshes.push(shutt);
                        }
                    }
                    if (t === 60) {
                        // Pour concrete slab — rebar first
                        for (let ri = 0; ri < 5; ri++) {
                            const rebar = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,fw+1.5,5), C.steel());
                            rebar.rotation.z = Math.PI/2;
                            rebar.position.set(cx,0.5,cz+(ri-2)*(fd/4));
                            scene.add(rebar); site.meshes.push(rebar);
                        }
                        for (let ri = 0; ri < 5; ri++) {
                            const rebar = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,fd+1.5,5), C.steel());
                            rebar.position.set(cx+(ri-2)*(fw/4),0.5,cz);
                            scene.add(rebar); site.meshes.push(rebar);
                        }
                    }
                    if (t === 120) {
                        // Concrete covers rebar
                        const slab = new THREE.Mesh(new THREE.BoxGeometry(fw+2,0.9,fd+2), C.concrete());
                        slab.position.set(cx,0.45,cz); slab.castShadow=true;
                        scene.add(slab); site.meshes.push(slab);
                        site.phase = 'scaffold'; site.timer = 0;
                    }

                } else if (site.phase === 'scaffold') {
                    if (t === 1) {
                        const poleH = site.floors*fh+5;
                        // Corner poles
                        const polePositions = [];
                        for (let xi = 0; xi <= Math.ceil(fw/3)+1; xi++) {
                            const px = cx-fw/2-1.2+xi*(fw/(Math.ceil(fw/3)+1));
                            polePositions.push([px,cz-fd/2-1.4],[px,cz+fd/2+1.4]);
                        }
                        for (let zi = 0; zi <= Math.ceil(fd/3)+1; zi++) {
                            const pz = cz-fd/2-1.2+zi*(fd/(Math.ceil(fd/3)+1));
                            polePositions.push([cx-fw/2-1.4,pz],[cx+fw/2+1.4,pz]);
                        }
                        polePositions.forEach(([px,pz]) => {
                            const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,poleH,6), C.steel());
                            pole.position.set(px,poleH/2,pz);
                            scene.add(pole); site.scaffoldMeshes.push(pole);
                        });
                        // Walkboard planks at each floor
                        for (let f = 0; f < site.floors; f++) {
                            const py = 1+(f+1)*fh-0.3;
                            for (const [wz,rot] of [[cz-fd/2-1.4,0],[cz+fd/2+1.4,0],[cx-fw/2-1.4,Math.PI/2],[cx+fw/2+1.4,Math.PI/2]]) {
                                const plank = new THREE.Mesh(new THREE.BoxGeometry(fw+3.4,0.2,0.85), C.wood());
                                plank.position.set(cx,py,wz); plank.rotation.y=rot;
                                scene.add(plank); site.scaffoldMeshes.push(plank);
                            }
                        }
                        // Safety net (orange)
                        const netMat = new THREE.MeshStandardMaterial({color:0xe87820,transparent:true,opacity:0.2,side:THREE.DoubleSide});
                        for (const [nx,nz,ry] of [[cx,cz-fd/2-1.4,0],[cx,cz+fd/2+1.4,0],[cx-fw/2-1.4,cz,Math.PI/2],[cx+fw/2+1.4,cz,Math.PI/2]]) {
                            const net = new THREE.Mesh(new THREE.BoxGeometry(fw+3.5,poleH,0.1), netMat);
                            net.position.set(nx,poleH/2,nz); net.rotation.y=ry;
                            scene.add(net); site.scaffoldMeshes.push(net);
                        }
                    }
                    if (t > 80) { site.phase='floors'; site.timer=0; site.currentFloor=0; }

                } else if (site.phase === 'floors') {
                    // True brick-by-brick: a queue of individual pieces to place
                    // Each tick, pop one item from the queue and add it to scene
                    if (!site.buildQueue) site.buildQueue = [];
                    if (!site.buildQueueReady) {
                        site.buildQueueReady = true;
                        site.buildTick = 0;
                        // Populate the queue for this floor
                        const f = site.currentFloor;
                        const y0 = 1.0 + f * fh;
                        const beamMat = C.steel();
                        const wallMat = site.isSkyscraper ? C.glass() : C.brick();
                        const BRICK_H = 0.24;
                        const COURSE_H = BRICK_H; // no mortar gap — bricks stack flush
                        const nCourses = Math.floor(fh / COURSE_H);
                        const nP = Math.floor(fw / 3); // panels per face

                        // ── Phase A: corner column rods, one segment at a time ──
                        const colSegs = Math.ceil(fh / 0.8);
                        for (const [cx2,cz2] of [[cx-fw/2+0.6,cz-fd/2+0.6],[cx+fw/2-0.6,cz-fd/2+0.6],[cx-fw/2+0.6,cz+fd/2-0.6],[cx+fw/2-0.6,cz+fd/2-0.6]]) {
                            for (let s = 0; s < colSegs; s++) {
                                const segY = y0 + s * (fh / colSegs);
                                site.buildQueue.push(() => {
                                    // Column rod segment
                                    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.18, fh/colSegs + 0.02, 0.18), beamMat);
                                    seg.position.set(cx2, segY + fh/colSegs/2, cz2);
                                    scene.add(seg); site.meshes.push(seg);
                                });
                            }
                        }

                        // ── Phase B: horizontal floor beams, one beam at a time ──
                        const xBeams = Math.floor(fw / 3) + 1;
                        for (let bi = 0; bi <= xBeams; bi++) {
                            const bz = cz - fd/2 + bi*(fd/xBeams);
                            site.buildQueue.push(() => {
                                const web = new THREE.Mesh(new THREE.BoxGeometry(fw-0.2, 0.35, 0.08), beamMat);
                                web.position.set(cx, y0+0.2, bz); scene.add(web); site.meshes.push(web);
                                for (const fy2 of [y0+0.06, y0+0.36]) {
                                    const fl = new THREE.Mesh(new THREE.BoxGeometry(fw-0.2, 0.07, 0.22), beamMat);
                                    fl.position.set(cx, fy2, bz); scene.add(fl); site.meshes.push(fl);
                                }
                            });
                        }
                        for (let bi = 0; bi <= Math.floor(fd/3)+1; bi++) {
                            const bx = cx-fw/2+bi*(fw/(Math.floor(fd/3)+1));
                            site.buildQueue.push(() => {
                                const web = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.35, fd-0.2), beamMat);
                                web.position.set(bx, y0+0.2, cz); scene.add(web); site.meshes.push(web);
                            });
                        }

                        // ── Phase C: walls — brick-by-brick for houses, glass panes for skyscrapers ──
                        if (site.isSkyscraper) {
                            // Curtain wall: one tall glass pane per panel per face, added one at a time
                            const paneH = fh - 0.5;
                            const frameMat = C.steel();
                            for (const wz of [cz - fd/2 + 0.14, cz + fd/2 - 0.14]) {
                                for (let pi = 0; pi < nP; pi++) {
                                    const panelX = cx - fw/2 + (pi + 0.5) * (fw/nP);
                                    const panelW = fw/nP;
                                    site.buildQueue.push(() => {
                                        // Thin aluminium frame around pane
                                        const frame = new THREE.Mesh(new THREE.BoxGeometry(panelW, paneH, 0.08), frameMat);
                                        frame.position.set(panelX, y0 + paneH/2 + 0.25, wz);
                                        scene.add(frame); site.meshes.push(frame);
                                        // Glass pane inside frame (slightly inset)
                                        const pane = new THREE.Mesh(
                                            new THREE.BoxGeometry(panelW - 0.14, paneH - 0.14, 0.06),
                                            new THREE.MeshStandardMaterial({ color: 0x7ecfed, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.75 })
                                        );
                                        pane.position.set(panelX, y0 + paneH/2 + 0.25, wz);
                                        pane.userData.isWindow = true;
                                        pane.userData.windowLit = Math.random() < 0.6;
                                        scene.add(pane); site.meshes.push(pane);
                                    });
                                }
                            }
                            // Side faces — full glass panels
                            for (const wx of [cx - fw/2 + 0.14, cx + fw/2 - 0.14]) {
                                const sidePanelCount = Math.max(1, Math.floor(fd / (fw/nP)));
                                for (let pi = 0; pi < sidePanelCount; pi++) {
                                    const pz = cz - fd/2 + (pi + 0.5) * (fd/sidePanelCount);
                                    const pw = fd/sidePanelCount;
                                    site.buildQueue.push(() => {
                                        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.08, paneH, pw), frameMat);
                                        frame.position.set(wx, y0 + paneH/2 + 0.25, pz);
                                        scene.add(frame); site.meshes.push(frame);
                                        const pane = new THREE.Mesh(
                                            new THREE.BoxGeometry(0.06, paneH - 0.14, pw - 0.14),
                                            new THREE.MeshStandardMaterial({ color: 0x7ecfed, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.75 })
                                        );
                                        pane.position.set(wx, y0 + paneH/2 + 0.25, pz);
                                        pane.userData.isWindow = true;
                                        pane.userData.windowLit = Math.random() < 0.6;
                                        scene.add(pane); site.meshes.push(pane);
                                    });
                                }
                            }
                        } else {
                            // Brick houses: individual bricks course by course
                            // WD = wall depth. Every brick on a face has this exact depth.
                            // Each brick center is WD/2 inward from the outer face plane — outer faces perfectly flush.
                            const WD = 0.28;

                        for (let course = 0; course < nCourses; course++) {
                            const courseY = y0 + course * COURSE_H;
                            const inWindow = course >= 4 && course <= nCourses - 4;
                            // Running bond: shift every other course by half a brick
                            // Use modulo-clamped positions so no brick ever starts before wall edge
                            const halfBrick = 0.325;

                            // Helper: lay a row of bricks along X between x0 and x1
                            const layRowX = (x0, x1, zCenter, brickShift) => {
                                const rowW = x1 - x0;
                                const nBricks = Math.max(1, Math.round(rowW / 0.65));
                                const brickW = rowW / nBricks; // exact fit — no remainder, no overflow
                                for (let bi2 = 0; bi2 < nBricks; bi2++) {
                                    const bx = x0 + (bi2 + 0.5) * brickW;
                                    site.buildQueue.push(() => {
                                        const b = new THREE.Mesh(new THREE.BoxGeometry(brickW, BRICK_H, WD), wallMat.clone());
                                        b.position.set(bx, courseY + BRICK_H/2, zCenter);
                                        scene.add(b); site.meshes.push(b);
                                    });
                                }
                            };

                            // Helper: lay a row of bricks along Z between z0 and z1
                            const layRowZ = (z0, z1, xCenter, brickShift) => {
                                const rowD = z1 - z0;
                                const nBricks = Math.max(1, Math.round(rowD / 0.65));
                                const brickD = rowD / nBricks;
                                for (let bi2 = 0; bi2 < nBricks; bi2++) {
                                    const bz = z0 + (bi2 + 0.5) * brickD;
                                    site.buildQueue.push(() => {
                                        const b = new THREE.Mesh(new THREE.BoxGeometry(WD, BRICK_H, brickD), wallMat.clone());
                                        b.position.set(xCenter, courseY + BRICK_H/2, bz);
                                        scene.add(b); site.meshes.push(b);
                                    });
                                }
                            };

                            // Wall face centers (brick centers inset by WD/2 from outer face)
                            const frontZ = cz - fd/2 + WD/2;
                            const backZ  = cz + fd/2 - WD/2;
                            const leftX  = cx - fw/2 + WD/2;
                            const rightX = cx + fw/2 - WD/2;

                            if (inWindow) {
                                // Window zone: only pillar strips beside each window opening
                                // Pillar = leftmost and rightmost slice of each panel
                                for (const faceZ of [frontZ, backZ]) {
                                    for (let pi = 0; pi < nP; pi++) {
                                        const panelL = cx - fw/2 + pi * (fw/nP);
                                        const panelR = cx - fw/2 + (pi+1) * (fw/nP);
                                        const pillarW = (fw/nP) * 0.22;
                                        // Left pillar of panel
                                        layRowX(panelL, panelL + pillarW, faceZ, 0);
                                        // Right pillar of panel
                                        layRowX(panelR - pillarW, panelR, faceZ, 0);
                                    }
                                }
                                // Side walls: full rows (no window on sides)
                                layRowZ(cz - fd/2, cz + fd/2, leftX,  0);
                                layRowZ(cz - fd/2, cz + fd/2, rightX, 0);
                            } else {
                                // Solid course: full rows on all four faces
                                layRowX(cx - fw/2, cx + fw/2, frontZ, halfBrick);
                                layRowX(cx - fw/2, cx + fw/2, backZ,  halfBrick);
                                layRowZ(cz - fd/2, cz + fd/2, leftX,  halfBrick);
                                layRowZ(cz - fd/2, cz + fd/2, rightX, halfBrick);
                            }
                        }
                        } // end brick houses

                        // ── Phase D: floor slab poured at the end ──
                        site.buildQueue.push(() => {
                            const slab = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.3, fd), C.concrete());
                            slab.position.set(cx, y0+fh-0.15, cz); slab.castShadow = true;
                            scene.add(slab); site.meshes.push(slab);
                        });
                        // Window panes — only for brick buildings (skyscrapers already have glass panels)
                        if (!site.isSkyscraper) {
                        for (let pi = 0; pi < nP; pi++) {
                            const wx = cx-fw/2+(pi+0.5)*(fw/nP);
                            for (const wz of [cz-fd/2+0.14, cz+fd/2-0.14]) {
                                site.buildQueue.push(() => {
                                    const win = new THREE.Mesh(new THREE.BoxGeometry(fw/nP*0.52, fh*0.62, 0.1), C.glass());
                                    win.position.set(wx, y0+fh/2, wz);
                                    win.userData.isWindow = true;
                                    win.userData.windowLit = Math.random() < 0.6;
                                    scene.add(win); site.meshes.push(win);
                                });
                            }
                        }
                        for (const wx of [cx-fw/2+0.14, cx+fw/2-0.14]) {
                            site.buildQueue.push(() => {
                                const winS = new THREE.Mesh(new THREE.BoxGeometry(0.1, fh*0.58, fd*0.38), C.glass());
                                winS.position.set(wx, y0+fh/2, cz);
                                winS.userData.isWindow = true; winS.userData.windowLit = Math.random() < 0.6;
                                scene.add(winS); site.meshes.push(winS);
                            });
                        }
                        } // end !isSkyscraper windows
                    }

                    // Pop items from queue — rate controlled by speed
                    // Base rate: 1 item every 2 ticks (at 1× = slow; at 40× = very fast)
                    site.buildTick++;
                    const itemsThisTick = Math.max(1, Math.floor(constrSpeed * 0.8));
                    for (let i = 0; i < itemsThisTick && site.buildQueue.length > 0; i++) {
                        const buildFn = site.buildQueue.shift();
                        buildFn();
                        // Trigger a worker carry every ~20 items
                        if (site.buildQueue.length % 20 === 0) {
                            const freeW = site.workerIds.map(wid => constrVehicles[wid])
                                .find(w => w && w.group && w.phase === 'working' && !w.carrying && !w.unpacking);
                            if (freeW) {
                                const y0w = 1.0 + site.currentFloor * fh;
                                freeW.carrying = true;
                                freeW.carryTarget = { x: cx, y: y0w, z: cz };
                                freeW.carryTimer = 0;
                                freeW.carryPhase = 'pickUp';
                                if (!freeW.brickMesh) {
                                    freeW.brickMesh = new THREE.Mesh(
                                        new THREE.BoxGeometry(0.55, 0.28, 0.28),
                                        site.isSkyscraper ? C.glass() : C.brick()
                                    );
                                    freeW.group.add(freeW.brickMesh);
                                    freeW.brickMesh.position.set(-0.5, 1.1, 0.3);
                                    freeW.brickMesh.visible = false;
                                }
                            }
                        }
                    }

                    // Floor done when queue is empty
                    if (site.buildQueue.length === 0 && site.buildQueueReady) {
                        site.buildQueueReady = false;
                        site.buildQueue = [];
                        site.currentFloor++;
                        if (site.currentFloor >= site.floors) {
                            site.phase = 'roof';
                            site.timer = 0;
                        }
                    }

                } else if (site.phase === 'roof') {
                    if (t === 1) {
                        const topY = 1.0+site.floors*fh;
                        if (site.isSkyscraper) {
                            const roof = new THREE.Mesh(new THREE.BoxGeometry(fw+0.4,0.5,fd+0.4), C.concrete());
                            roof.position.set(cx,topY+0.25,cz); scene.add(roof); site.meshes.push(roof);
                            const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.22,7,6), C.steel());
                            ant.position.set(cx,topY+4,cz); scene.add(ant); site.meshes.push(ant);
                            const blink = new THREE.Mesh(new THREE.SphereGeometry(0.2,8,6),
                                new THREE.MeshStandardMaterial({color:0xff2200,emissive:0xff0000,emissiveIntensity:1.5}));
                            blink.position.set(cx,topY+7.6,cz); scene.add(blink); site.meshes.push(blink);
                            for (let ac=0;ac<3;ac++) {
                                const acU = new THREE.Mesh(new THREE.BoxGeometry(1.6,0.9,1.6), C.white());
                                acU.position.set(cx+(ac-1)*3.5,topY+0.95,cz+fd/3);
                                scene.add(acU); site.meshes.push(acU);
                            }
                        } else {
                            const rb = new THREE.Mesh(new THREE.BoxGeometry(fw+0.6,0.3,fd+0.6), C.concrete());
                            rb.position.set(cx,topY+0.15,cz); scene.add(rb); site.meshes.push(rb);
                            const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.01,Math.sqrt(fw*fw+fd*fd)/2*0.72,fw*0.5,4), C.brick());
                            peak.position.set(cx,topY+fw*0.25+0.3,cz); peak.rotation.y=Math.PI/4;
                            scene.add(peak); site.meshes.push(peak);
                            // Chimney
                            const ch = new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.4,1.8,8), C.brick());
                            ch.position.set(cx+fw*0.25,topY+fw*0.5+0.5,cz+fd*0.2);
                            scene.add(ch); site.meshes.push(ch);
                        }

                        site.phase = 'teardownScaffold';
                        site.timer = 0;
                    }

                } else if (site.phase === 'teardownScaffold') {
                    if (t === 1) {
                        updateConstrStatus(`Building ${constrSites.indexOf(site)+1} — removing scaffolding...`);
                        removeScaffolding(site);
                        if (site.ghost) {
                            site.ghost.material.opacity = 0;
                            setTimeout(() => { if (site.ghost) scene.remove(site.ghost); site.ghost=null; }, 600);
                        }
                    }
                    if (t > 120) {
                        site.phase = 'interior';
                        site.timer = 0;
                        site.interiorStep = 0;
                        site.interiorTimer = 0;
                        updateConstrStatus(`Building ${constrSites.indexOf(site)+1} — interior fit-out...`);
                    }

                } else if (site.phase === 'interior') {
                    site.interiorTimer++;
                    // Each step takes ~80 frames before the next starts
                    if (site.interiorTimer >= 80) {
                        site.interiorTimer = 0;
                        const topY = 1.0 + site.floors * fh;

                        const interiorSteps = [
                            // Step 0: Lift shaft — vertical box running full height in center
                            () => {
                                const liftH = site.floors * fh - 0.5;
                                const shaft = new THREE.Mesh(
                                    new THREE.BoxGeometry(1.8, liftH, 1.8),
                                    new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.7 })
                                );
                                shaft.position.set(cx + fw*0.28, 1.0 + liftH/2, cz);
                                scene.add(shaft); site.meshes.push(shaft);
                                // Lift doors per floor
                                for (let f2 = 0; f2 < site.floors; f2++) {
                                    const doorY = 1.0 + f2*fh + fh*0.5;
                                    const door = new THREE.Mesh(new THREE.BoxGeometry(1.4, fh*0.7, 0.12), C.chrome());
                                    door.position.set(cx + fw*0.28, doorY, cz - 0.95);
                                    scene.add(door); site.meshes.push(door);
                                }
                                // Lift car
                                const car = new THREE.Mesh(new THREE.BoxGeometry(1.6, fh*0.7, 1.5),
                                    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.4, metalness: 0.5 }));
                                car.position.set(cx + fw*0.28, 1.0 + fh*0.35, cz);
                                scene.add(car); site.meshes.push(car);
                            },
                            // Step 1: Interior partition walls (per floor)
                            () => {
                                for (let f2 = 0; f2 < Math.min(site.floors, 3); f2++) {
                                    const wy = 1.0 + f2*fh + fh/2;
                                    // Central dividing wall
                                    const wall = new THREE.Mesh(new THREE.BoxGeometry(fw*0.55, fh-0.4, 0.18), C.cream());
                                    wall.position.set(cx - fw*0.1, wy, cz - fd*0.15);
                                    scene.add(wall); site.meshes.push(wall);
                                    // Doorway opening in wall
                                    const door = new THREE.Mesh(new THREE.BoxGeometry(0.12, fh*0.65, 0.9),
                                        new THREE.MeshStandardMaterial({ color: 0x7c5c3a, roughness: 0.7 }));
                                    door.position.set(cx + fw*0.05, 1.0+f2*fh+fh*0.33, cz-fd*0.15+0.1);
                                    door.rotation.y = Math.PI/2;
                                    scene.add(door); site.meshes.push(door);
                                }
                            },
                            // Step 2: Staircase
                            () => {
                                const stairX = cx - fw*0.3, stairZ = cz - fd*0.3;
                                for (let f2 = 0; f2 < site.floors; f2++) {
                                    const steps = 8;
                                    for (let s2 = 0; s2 < steps; s2++) {
                                        const stepY = 1.0 + f2*fh + s2*(fh/steps);
                                        const step = new THREE.Mesh(
                                            new THREE.BoxGeometry(fw*0.18, 0.18, fw*0.04),
                                            C.concrete()
                                        );
                                        step.position.set(stairX, stepY + 0.09, stairZ + s2*(fw*0.04));
                                        scene.add(step); site.meshes.push(step);
                                    }
                                    // Handrail
                                    const rail = new THREE.Mesh(
                                        new THREE.CylinderGeometry(0.06, 0.06, fh, 6),
                                        C.chrome()
                                    );
                                    rail.rotation.z = Math.atan2(fh, fw*0.32);
                                    rail.position.set(stairX, 1.0+f2*fh+fh/2, stairZ + steps*(fw*0.04)*0.5);
                                    scene.add(rail); site.meshes.push(rail);
                                }
                            },
                            // Step 3: Furniture (tables, chairs visible through windows)
                            () => {
                                for (let f2 = 0; f2 < site.floors; f2++) {
                                    const roomY = 1.0 + f2*fh;
                                    const offset = [(cx-fw*0.15),(cx+fw*0.1)];
                                    offset.forEach((ox, oi) => {
                                        // Table
                                        const table = new THREE.Mesh(new THREE.BoxGeometry(1.5,0.1,0.9), C.wood());
                                        table.position.set(ox, roomY+0.9, cz+(oi%2===0?-fd*0.1:fd*0.1));
                                        scene.add(table); site.meshes.push(table);
                                        const leg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,0.9,6), C.wood());
                                        leg1.position.set(ox-0.6,roomY+0.45,cz+(oi%2===0?-fd*0.1:fd*0.1));
                                        scene.add(leg1); site.meshes.push(leg1);
                                        const leg2 = leg1.clone();
                                        leg2.position.x = ox+0.6;
                                        scene.add(leg2); site.meshes.push(leg2);
                                        // Chair
                                        const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.08,0.5), C.cream());
                                        seat.position.set(ox,roomY+0.55,cz+(oi%2===0?fd*0.05:-fd*0.05));
                                        scene.add(seat); site.meshes.push(seat);
                                        const back = new THREE.Mesh(new THREE.BoxGeometry(0.5,0.5,0.06), C.cream());
                                        back.position.set(ox,roomY+0.8,cz+(oi%2===0?fd*0.05:-fd*0.05)-0.22);
                                        scene.add(back); site.meshes.push(back);
                                    });
                                }
                            },
                            // Step 4: Window frames & glass finishing
                            () => {
                                for (let f2 = 0; f2 < site.floors; f2++) {
                                    const wy = 1.0 + f2*fh + fh*0.5;
                                    const frameMat = C.chrome();
                                    for (const [wz] of [[cz-fd/2+0.05],[cz+fd/2-0.05]]) {
                                        const nP = Math.floor(fw/3);
                                        for (let pi = 0; pi < nP; pi++) {
                                            const wx = cx-fw/2+(pi+0.5)*(fw/nP);
                                            // Window cross frame
                                            const hBar = new THREE.Mesh(new THREE.BoxGeometry(fw/nP*0.52,0.06,0.06), frameMat);
                                            hBar.position.set(wx,wy,wz); scene.add(hBar); site.meshes.push(hBar);
                                            const vBar = new THREE.Mesh(new THREE.BoxGeometry(0.06,fh*0.62,0.06), frameMat);
                                            vBar.position.set(wx,wy,wz); scene.add(vBar); site.meshes.push(vBar);
                                        }
                                    }
                                }
                            },
                            // Step 5: Balconies (if hasBalcony)
                            () => {
                                if (!site.hasBalcony) return;
                                // Add balconies on floors 1+ on the front face
                                for (let f2 = 1; f2 < site.floors; f2++) {
                                    const balY = 1.0 + f2*fh;
                                    const balDepth = 1.8;
                                    const balWidth = fw * 0.45;
                                    // Slab
                                    const balSlab = new THREE.Mesh(new THREE.BoxGeometry(balWidth,0.18,balDepth), C.concrete());
                                    balSlab.position.set(cx, balY+0.09, cz-fd/2-1-balDepth/2);
                                    scene.add(balSlab); site.meshes.push(balSlab);
                                    // Railing posts
                                    const postCount = Math.floor(balWidth/0.8)+1;
                                    for (let p = 0; p <= postCount; p++) {
                                        const px = cx-balWidth/2+p*(balWidth/postCount);
                                        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.9,6), C.chrome());
                                        post.position.set(px, balY+0.6, cz-fd/2-1-balDepth+0.12);
                                        scene.add(post); site.meshes.push(post);
                                    }
                                    // Top rail
                                    const rail = new THREE.Mesh(new THREE.BoxGeometry(balWidth+0.1,0.07,0.07), C.chrome());
                                    rail.position.set(cx, balY+1.0, cz-fd/2-1-balDepth+0.12);
                                    scene.add(rail); site.meshes.push(rail);
                                    // Side rails
                                    for (const sx of [-balWidth/2, balWidth/2]) {
                                        const sRail = new THREE.Mesh(new THREE.BoxGeometry(0.07,0.07,balDepth), C.chrome());
                                        sRail.position.set(cx+sx, balY+1.0, cz-fd/2-1-balDepth/2);
                                        scene.add(sRail); site.meshes.push(sRail);
                                    }
                                    // Glass balustrade panels
                                    const panel = new THREE.Mesh(new THREE.BoxGeometry(balWidth*0.85, 0.75, 0.05), C.glass());
                                    panel.position.set(cx, balY+0.5, cz-fd/2-1-balDepth+0.14);
                                    scene.add(panel); site.meshes.push(panel);
                                }
                            },
                            // Step 6: Plumbing & electrical (visible conduit pipes)
                            () => {
                                const pipeMat = new THREE.MeshStandardMaterial({ color: 0xd4a853, roughness: 0.5, metalness: 0.6 });
                                for (let f2 = 0; f2 < Math.min(3, site.floors); f2++) {
                                    const py = 1.0 + f2*fh + fh*0.88;
                                    // Horizontal conduit run
                                    const conduit = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,fw*0.7,8), pipeMat);
                                    conduit.rotation.z = Math.PI/2;
                                    conduit.position.set(cx, py, cz - fd*0.3);
                                    scene.add(conduit); site.meshes.push(conduit);
                                    // Vertical drops
                                    for (let d = 0; d < 3; d++) {
                                        const drop = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.05,0.8,8), pipeMat);
                                        drop.position.set(cx-fw*0.25+d*fw*0.25, py-0.4, cz-fd*0.3);
                                        scene.add(drop); site.meshes.push(drop);
                                    }
                                }
                            },
                        ];

                        if (site.interiorStep < interiorSteps.length) {
                            interiorSteps[site.interiorStep]();
                            site.interiorStep++;
                            const stepNames = ['lift shaft','partition walls','staircase','furniture','window frames','balconies','plumbing'];
                            updateConstrStatus(`Building ${constrSites.indexOf(site)+1} — fitting: ${stepNames[site.interiorStep-1]||'finishing'}`);
                        } else {
                            // All interior work done
                            site.phase = 'done';
                            site.done = true;
                            updateConstrStatus(`🏗️ Building ${constrSites.indexOf(site)+1} complete! Workers packing up...`);

                            const crane = constrVehicles[site.craneId];
                            if (crane) crane.phase = 'lowerLoad';
                            site.workerIds.forEach(wid => {
                                const w = constrVehicles[wid];
                                if (w) {
                                    // Worker climbs down ladder before leaving
                                    w.phase = 'ladderDown';
                                    w.departAngle = Math.random() * Math.PI * 2;
                                    w.ladderTimer = 0;
                                    // Move to scaffold edge position to start descent
                                    w.group.position.x = site.cx + site.width/2 + 1.5;
                                    w.group.position.z = site.cz + (Math.random() - 0.5) * site.depth;
                                }
                            });
                            if (constrSites.filter(s=>!s.done).length === 0) {
                                setTimeout(() => addConstructionSite(), 400);
                            }
                        }
                    }
                } // end interior phase

            }); // end constrSites.forEach

            // ── VEHICLES ─────────────────────────────────────────────────
            constrVehicles.forEach(v => {
                if (!v || !v.group) return;
                v.timer++;
                const site = v.site;

                if (v.type === 'truck') {
                    if (v.phase === 'approach') {
                        const destX = site.cx + site.width/2 + 10;
                        const destZ = site.cz;
                        const dx = destX-v.group.position.x, dz = destZ-v.group.position.z;
                        const dist = Math.sqrt(dx*dx+dz*dz);
                        if (dist > 1.5) {
                            v.group.position.x += (dx/dist)*v.speed;
                            v.group.position.z += (dz/dist)*v.speed;
                            v.group.rotation.y = Math.atan2(dx,dz);
                            v.group.position.y = Math.abs(Math.sin(v.timer*0.08))*0.06;
                        } else {
                            v.phase='unload'; v.timer=0;
                        }
                    } else if (v.phase === 'unload') {
                        // Tilt bed to slide pallet off
                        const tiltAngle = Math.min(0.45, v.timer * 0.005);
                        if (v.group.children[1]) v.group.children[1].rotation.x = tiltAngle;
                        // At peak tilt, drop the pallet onto the ground
                        if (v.timer === 70 && !v.palletDropped) {
                            v.palletDropped = true;
                            // Create a standalone pallet at the truck's drop zone
                            const palletGroup = new THREE.Group();
                            // Pallet base
                            const base = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.25, 2.8), C.wood());
                            palletGroup.add(base);
                            // Material stack on top (bricks / concrete bags)
                            for (let row = 0; row < 2; row++) {
                                for (let col = 0; col < 2; col++) {
                                    const block = new THREE.Mesh(
                                        new THREE.BoxGeometry(1.1, 0.5, 1.1),
                                        Math.random() < 0.5 ? C.brick() : C.concrete()
                                    );
                                    block.position.set(-0.6 + col * 1.2, 0.4 + row * 0.55, -0.6 + row * 1.2);
                                    palletGroup.add(block);
                                }
                            }
                            // Wrapping straps
                            for (const sx of [-0.9, 0.9]) {
                                const strap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 3), C.orange());
                                strap.position.set(sx, 0.6, 0);
                                palletGroup.add(strap);
                            }
                            // Place near truck's side, beside the site
                            const dropX = site.cx + site.width / 2 + 4 + (Math.random() - 0.5) * 3;
                            const dropZ = site.cz + (Math.random() - 0.5) * 4;
                            palletGroup.position.set(dropX, 0.12, dropZ);
                            scene.add(palletGroup);
                            // Register pallet with site so crane can pick it up
                            if (!site.waitingPallets) site.waitingPallets = [];
                            site.waitingPallets.push({
                                group: palletGroup,
                                state: 'waiting', // waiting → hooked → delivered → unpacking → done
                                worldPos: new THREE.Vector3(dropX, 0.12, dropZ),
                            });
                        }
                        if (v.timer > 100) {
                            // Level bed back and drive away
                            if (v.group.children[1]) v.group.children[1].rotation.x = 0;
                            // Hide truck's own cargo mesh (it's been dropped)
                            if (v.group.children[2]) v.group.children[2].visible = false;
                            v.palletDropped = false;
                            v.phase = 'depart'; v.timer = 0;
                        }
                    } else if (v.phase === 'depart') {
                        const ang = v.departAngle;
                        v.group.position.x += Math.sin(ang) * v.speed * 1.6;
                        v.group.position.z += Math.cos(ang) * v.speed * 1.6;
                        v.group.rotation.y = ang;
                        v.group.position.y = Math.abs(Math.sin(v.timer * 0.08)) * 0.06;
                        const d = v.group.position.distanceTo(new THREE.Vector3(site.cx, 0, site.cz));
                        if (d > 130) {
                            if (!site.done) {
                                const a2 = Math.random() * Math.PI * 2;
                                v.group.position.set(site.cx + Math.cos(a2) * 115, 0, site.cz + Math.sin(a2) * 115);
                                v.departAngle = a2 + Math.PI;
                                v.angle = a2;
                                v.phase = 'approach'; v.timer = 0;
                                // Reload cargo mesh
                                if (v.group.children[2]) v.group.children[2].visible = true;
                            } else {
                                scene.remove(v.group); v.group = null;
                            }
                        }
                    }

                } else if (v.type === 'crane') {
                    if (v.phase === 'working') {
                        // ── PALLET PICKUP CYCLE ────────────────────────────────
                        // States: swingToDrop → lowerToGround → hookPallet → liftPallet
                        //         → swingToFloor → lowerToFloor → releasePallet → liftBack → repeat

                        if (!v.craneState) {
                            v.craneState = 'idle';
                            v.activePallet = null;
                            v.craneStateTimer = 0;
                        }
                        v.craneStateTimer++;

                        if (v.craneState === 'idle') {
                            // Check if there's a waiting pallet
                            const pallet = (site.waitingPallets || []).find(p => p.state === 'waiting');
                            if (pallet) {
                                pallet.state = 'hooked';
                                v.activePallet = pallet;
                                v.craneState = 'swingToDrop';
                                v.craneStateTimer = 0;
                            }
                            // While idle, gentle sway
                            v.jibPivot.rotation.y += (Math.PI * 0.2 - v.jibPivot.rotation.y) * 0.02;

                        } else if (v.craneState === 'swingToDrop') {
                            // Swing jib toward the drop zone (behind crane, at site edge)
                            const dropX = v.activePallet.worldPos.x - v.group.position.x;
                            const dropZ = v.activePallet.worldPos.z - v.group.position.z;
                            const targetAngle = Math.atan2(dropX, dropZ) - v.group.rotation.y;
                            v.jibPivot.rotation.y += (targetAngle - v.jibPivot.rotation.y) * 0.04;
                            // Extend trolley to reach pallet
                            const dist = Math.sqrt(dropX * dropX + dropZ * dropZ);
                            const targetTrolley = Math.min(18, Math.max(2, dist - 1));
                            v.trolleyOffset += (targetTrolley - v.trolleyOffset) * 0.04;
                            v.trolley.position.x = v.trolleyOffset;
                            v.cableGroup.position.x = v.trolleyOffset;
                            // Keep cable up while swinging
                            v.hoistY += (-2 - v.hoistY) * 0.05;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            v.cableGroup.children[0].scale.y = cl / 7;
                            v.cableGroup.children[0].position.y = -cl / 2;
                            v.cableGroup.children[1].position.y = -cl - 0.5;
                            v.cableGroup.children[2].position.y = -cl - 1;
                            v.loadPallet.position.y = -cl - 2.5;
                            if (Math.abs(v.jibPivot.rotation.y - targetAngle) < 0.08 && v.craneStateTimer > 60) {
                                v.craneState = 'lowerToGround';
                                v.craneStateTimer = 0;
                            }

                        } else if (v.craneState === 'lowerToGround') {
                            // Lower cable to ground level to hook the pallet
                            // Target hoistY: needs to reach pallet height (~0) from crane's height
                            const craneWorldY = v.group.position.y + (v.jibPivot.position.y || 57);
                            const targetHoist = -(craneWorldY - 1.5); // just above ground
                            v.hoistY += (targetHoist - v.hoistY) * 0.025;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            v.cableGroup.children[0].scale.y = cl / 7;
                            v.cableGroup.children[0].position.y = -cl / 2;
                            v.cableGroup.children[1].position.y = -cl - 0.5;
                            v.cableGroup.children[2].position.y = -cl - 1;
                            v.loadPallet.position.y = -cl - 2.5;
                            // Hide own loadPallet visual while we're picking up a real one
                            v.loadPallet.visible = false;
                            if (v.hoistY < targetHoist + 2 && v.craneStateTimer > 80) {
                                // Hook is down — attach the world pallet to the crane
                                const p = v.activePallet;
                                // Reparent pallet: move from scene to under cableGroup
                                scene.remove(p.group);
                                v.cableGroup.add(p.group);
                                p.group.position.set(0, v.hoistY - 2.5 - (v.group.position.y + 57), 0);
                                v.craneState = 'liftPallet';
                                v.craneStateTimer = 0;
                            }

                        } else if (v.craneState === 'liftPallet') {
                            // Lift pallet off ground
                            v.hoistY += (-3 - v.hoistY) * 0.03;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            v.cableGroup.children[0].scale.y = cl / 7;
                            v.cableGroup.children[0].position.y = -cl / 2;
                            v.cableGroup.children[1].position.y = -cl - 0.5;
                            v.cableGroup.children[2].position.y = -cl - 1;
                            // Pallet rides at end of cable
                            if (v.activePallet) v.activePallet.group.position.y = -cl - 3;
                            if (Math.abs(v.hoistY + 3) < 0.5) {
                                v.craneState = 'swingToFloor';
                                v.craneStateTimer = 0;
                            }

                        } else if (v.craneState === 'swingToFloor') {
                            // Swing jib to over the current floor of the building
                            const targetAngle = 0; // toward building (crane is beside it)
                            v.jibPivot.rotation.y += (targetAngle - v.jibPivot.rotation.y) * 0.03;
                            // Position trolley over building center
                            const targetTrolley = Math.min(14, Math.max(4, site.width * 0.3));
                            v.trolleyOffset += (targetTrolley - v.trolleyOffset) * 0.03;
                            v.trolley.position.x = v.trolleyOffset;
                            v.cableGroup.position.x = v.trolleyOffset;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            if (v.activePallet) v.activePallet.group.position.y = -cl - 3;
                            // Slight pendulum swing of pallet
                            if (v.activePallet) v.activePallet.group.rotation.z = Math.sin(v.craneStateTimer * 0.08) * 0.04;
                            if (Math.abs(v.jibPivot.rotation.y - targetAngle) < 0.06 && v.craneStateTimer > 80) {
                                v.craneState = 'lowerToFloor';
                                v.craneStateTimer = 0;
                            }

                        } else if (v.craneState === 'lowerToFloor') {
                            // Lower pallet to current floor level
                            const floorY = 1.0 + site.currentFloor * site.floorH;
                            const craneWorldY = v.group.position.y + 57;
                            const targetHoist = -(craneWorldY - floorY - 2);
                            v.hoistY += (targetHoist - v.hoistY) * 0.02;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            v.cableGroup.children[0].scale.y = cl / 7;
                            v.cableGroup.children[0].position.y = -cl / 2;
                            v.cableGroup.children[1].position.y = -cl - 0.5;
                            v.cableGroup.children[2].position.y = -cl - 1;
                            if (v.activePallet) v.activePallet.group.position.y = -cl - 3;
                            if (v.hoistY < targetHoist + 1.5 && v.craneStateTimer > 100) {
                                // Pallet landed on floor — detach from crane
                                const p = v.activePallet;
                                v.cableGroup.remove(p.group);
                                // Place pallet in world at floor level
                                const floorWorldX = site.cx;
                                const floorWorldZ = site.cz;
                                p.group.position.set(floorWorldX, floorY + 0.12, floorWorldZ);
                                scene.add(p.group);
                                p.state = 'delivered';
                                p.deliveredFloor = site.currentFloor;
                                // Signal a worker to unpack it
                                const freeWorker = site.workerIds
                                    .map(wid => constrVehicles[wid])
                                    .find(w => w && w.group && w.phase === 'working' && !w.unpacking);
                                if (freeWorker) {
                                    freeWorker.unpacking = true;
                                    freeWorker.unpackTarget = p;
                                    freeWorker.unpackTimer = 0;
                                    freeWorker.prevPhase = 'working';
                                }
                                v.activePallet = null;
                                v.loadPallet.visible = true;
                                v.craneState = 'liftBack';
                                v.craneStateTimer = 0;
                            }

                        } else if (v.craneState === 'liftBack') {
                            // Lift cable back up, ready for next pallet
                            v.hoistY += (-2 - v.hoistY) * 0.04;
                            const cl = Math.max(0.5, Math.abs(v.hoistY));
                            v.cableGroup.children[0].scale.y = cl / 7;
                            v.cableGroup.children[0].position.y = -cl / 2;
                            v.cableGroup.children[1].position.y = -cl - 0.5;
                            v.cableGroup.children[2].position.y = -cl - 1;
                            v.loadPallet.position.y = -cl - 2.5;
                            if (Math.abs(v.hoistY + 2) < 0.5) {
                                v.craneState = 'idle';
                                v.craneStateTimer = 0;
                            }
                        }

                    } else if (v.phase === 'lowerLoad') {
                        // Building done — lower load to ground first, then park jib
                        v.hoistY += (-2-v.hoistY)*0.025;
                        const cableLen = Math.max(0.5, Math.abs(v.hoistY));
                        v.cableGroup.children[0].scale.y = cableLen/7;
                        v.cableGroup.children[0].position.y = -cableLen/2;
                        v.cableGroup.children[1].position.y = -cableLen-0.5;
                        v.cableGroup.children[2].position.y = -cableLen-1;
                        v.loadPallet.position.y = -cableLen-2.5;
                        if (Math.abs(v.hoistY+2) < 0.5) { v.phase='jibHome'; v.timer=0; }

                    } else if (v.phase === 'jibHome') {
                        // Rotate jib to home position (pointing away from building)
                        const homeAngle = -Math.PI/2;
                        v.jibPivot.rotation.y += (homeAngle-v.jibPivot.rotation.y)*0.04;
                        // Retract trolley to center
                        v.trolleyOffset += (0-v.trolleyOffset)*0.04;
                        v.trolley.position.x = v.trolleyOffset;
                        v.cableGroup.position.x = v.trolleyOffset;
                        if (Math.abs(v.jibPivot.rotation.y-homeAngle) < 0.05 && v.timer > 60) {
                            v.phase='dismantleJib'; v.timer=0;
                        }

                    } else if (v.phase === 'dismantleJib') {
                        // Jib slowly folds down (lower opacity then remove visually)
                        if (v.timer < 30) {
                            // Hide load pallet (packed away)
                            v.loadPallet.visible = false;
                        }
                        if (v.timer === 60) {
                            // Remove jib children visually (they fold down)
                            v.jibPivot.rotation.z = 0.02*v.timer;
                        }
                        v.jibPivot.rotation.z = Math.min(Math.PI/2, v.timer*0.015);
                        if (v.timer > 120) { v.phase='dismantleTower'; v.timer=0; }

                    } else if (v.phase === 'dismantleTower') {
                        // Shorten mast progressively by scaling down
                        const scaleFactor = Math.max(0.05, 1 - v.timer*0.008);
                        // Scale all the tower columns (children after base and outriggers)
                        if (v.timer % 5 === 0 && v.timer < 120) {
                            v.group.scale.y = scaleFactor;
                            v.group.position.y = -(1-scaleFactor)*v.towerH*0.5;
                        }
                        if (v.timer > 130) {
                            v.group.scale.set(1,1,1);
                            v.group.position.y = 0;
                            v.phase='drive'; v.timer=0;
                        }

                    } else if (v.phase === 'drive') {
                        // Crane drives away on its base (slowly)
                        const ang = v.departAngle;
                        v.group.position.x += Math.sin(ang)*0.25;
                        v.group.position.z += Math.cos(ang)*0.25;
                        v.group.rotation.y += (ang-v.group.rotation.y)*0.05;
                        // Bounce slightly
                        v.group.position.y = Math.abs(Math.sin(v.timer*0.05))*0.08;
                        const d = v.group.position.distanceTo(new THREE.Vector3(v.craneX,0,v.craneZ));
                        if (d > 100) { scene.remove(v.group); v.group=null; }
                    }

                } else if (v.type === 'worker') {
                    if (v.phase === 'working') {
                        // ── UNPACKING: worker walks to delivered pallet and opens it ──
                        if (v.unpacking && v.unpackTarget) {
                            v.unpackTimer++;
                            const pallet = v.unpackTarget;
                            const px = pallet.group.position.x;
                            const pz = pallet.group.position.z;
                            const dx = px - v.group.position.x;
                            const dz = pz - v.group.position.z;
                            const dist = Math.sqrt(dx*dx + dz*dz);

                            if (dist > 1.5 && pallet.state === 'delivered') {
                                // Walk toward pallet
                                const spd = 0.18;
                                v.group.position.x += (dx / dist) * spd;
                                v.group.position.z += (dz / dist) * spd;
                                v.group.rotation.y = Math.atan2(dx, dz);
                                v.armPhase += 0.1;
                                if (v.group.children[4]) v.group.children[4].rotation.z = -0.3 + Math.sin(v.armPhase) * 0.5;
                                if (v.group.children[5]) v.group.children[5].rotation.z = 0.3 + Math.sin(v.armPhase + Math.PI) * 0.5;
                            } else if (pallet.state === 'delivered') {
                                // Arrived — start unpacking
                                pallet.state = 'unpacking';
                                v.group.rotation.y = Math.atan2(dx, dz);
                            }

                            if (pallet.state === 'unpacking') {
                                // Unpack animation: bend over the pallet, cut straps
                                v.armPhase += 0.15;
                                // Lean forward
                                v.group.rotation.x = 0.4;
                                if (v.group.children[4]) v.group.children[4].rotation.z = -1.2 + Math.sin(v.armPhase * 2) * 0.4;
                                if (v.group.children[5]) v.group.children[5].rotation.z = 1.2 + Math.sin(v.armPhase * 2 + Math.PI) * 0.4;
                                // Shake pallet contents
                                pallet.group.rotation.y = Math.sin(v.armPhase * 0.5) * 0.06;

                                if (v.unpackTimer > 120) {
                                    // Straps removed — hide strap meshes (children[2] and [3] of pallet)
                                    if (pallet.group.children[2]) pallet.group.children[2].visible = false;
                                    if (pallet.group.children[3]) pallet.group.children[3].visible = false;
                                }

                                if (v.unpackTimer > 200) {
                                    // Contents consumed by construction — remove all cleanly
                                    while (pallet.group.children.length > 0) {
                                        const child = pallet.group.children[0];
                                        pallet.group.remove(child);
                                        if (child.geometry) child.geometry.dispose();
                                        if (child.material) child.material.dispose();
                                    }
                                    scene.remove(pallet.group);
                                    pallet.state = 'done';
                                    v.group.rotation.x = 0;
                                    v.unpacking = false;
                                    v.unpackTarget = null;
                                    v.unpackTimer = 0;
                                }
                            }

                        } else {
                            // ── BRICK CARRYING: worker picks up, carries to wall, places ──
                        if (v.carrying && v.carryTarget) {
                            v.carryTimer++;
                            if (v.brickMesh) v.brickMesh.visible = true;
                            const tx = v.carryTarget.x, ty = v.carryTarget.y, tz = v.carryTarget.z;

                            if (v.carryPhase === 'pickUp') {
                                // Walk to pallet / ground
                                const pickupX = site.cx + site.width/2 + 4;
                                const dx = pickupX - v.group.position.x;
                                const dz = site.cz - v.group.position.z;
                                const d = Math.sqrt(dx*dx + dz*dz);
                                if (d > 1.5) {
                                    v.group.position.x += (dx/d) * 0.18;
                                    v.group.position.z += (dz/d) * 0.18;
                                    v.group.rotation.y = Math.atan2(dx, dz);
                                    v.armPhase += 0.1;
                                } else {
                                    // Pick up — bend down briefly
                                    if (v.carryTimer < 30) {
                                        v.group.rotation.x = Math.min(0.5, v.carryTimer * 0.017);
                                    } else {
                                        v.group.rotation.x = 0;
                                        v.carryPhase = 'carry';
                                        v.carryTimer = 0;
                                    }
                                }
                            } else if (v.carryPhase === 'carry') {
                                // Walk to wall position carrying the brick
                                const floorY = ty;
                                const destX = tx + (Math.random() - 0.5) * (site.width * 0.6);
                                const destZ = tz - site.depth/2 - 0.8;
                                const dx = destX - v.group.position.x;
                                const dz = destZ - v.group.position.z;
                                const d = Math.sqrt(dx*dx + dz*dz);
                                if (d > 1.2) {
                                    v.group.position.x += (dx/d) * 0.14;
                                    v.group.position.z += (dz/d) * 0.14;
                                    v.group.position.y = floorY;
                                    v.group.rotation.y = Math.atan2(dx, dz);
                                    v.armPhase += 0.08;
                                    // Arms forward carrying posture
                                    if (v.group.children[4]) v.group.children[4].rotation.z = -1.1;
                                    if (v.group.children[5]) v.group.children[5].rotation.z = 1.1;
                                    if (v.brickMesh) v.brickMesh.position.set(0, 1.3, 0.45);
                                } else {
                                    v.carryPhase = 'place';
                                    v.carryTimer = 0;
                                }
                            } else if (v.carryPhase === 'place') {
                                // Placing motion: lean forward, lower brick to wall
                                v.group.rotation.x = 0.3;
                                v.armPhase += 0.12;
                                if (v.group.children[4]) v.group.children[4].rotation.z = -1.5 + Math.sin(v.armPhase) * 0.2;
                                if (v.group.children[5]) v.group.children[5].rotation.z = 1.5 + Math.sin(v.armPhase + Math.PI) * 0.2;
                                if (v.brickMesh) {
                                    v.brickMesh.position.z = 0.45 + Math.min(0.4, v.carryTimer * 0.008);
                                }
                                if (v.carryTimer > 60) {
                                    // Brick placed — hide from hand
                                    if (v.brickMesh) { v.brickMesh.visible = false; v.brickMesh.position.set(-0.5,1.1,0.3); }
                                    v.group.rotation.x = 0;
                                    v.carryPhase = 'return';
                                    v.carryTimer = 0;
                                }
                            } else if (v.carryPhase === 'return') {
                                // Return to normal walking circuit
                                v.group.rotation.x *= 0.85;
                                if (v.group.children[4]) v.group.children[4].rotation.z += (-0.4 - v.group.children[4].rotation.z) * 0.1;
                                if (v.group.children[5]) v.group.children[5].rotation.z += (0.4 - v.group.children[5].rotation.z) * 0.1;
                                v.carryTimer++;
                                if (v.carryTimer > 30) {
                                    v.carrying = false;
                                    v.carryTarget = null;
                                    v.carryPhase = null;
                                }
                            }
                        } else {
                            // Normal walking circuit
                            v.taskTimer++; v.armPhase += 0.08;
                            if (v.group.children[4]) v.group.children[4].rotation.z = -0.4 + Math.sin(v.armPhase) * 0.7;
                            if (v.group.children[5]) v.group.children[5].rotation.z = 0.4 + Math.sin(v.armPhase + Math.PI) * 0.4;
                            v.walkAngle += v.walkSpeed;
                            const fy = Math.max(0, (site.currentFloor - 1) * site.floorH);
                            v.group.position.x = site.cx + Math.cos(v.walkAngle) * v.walkRadius;
                            v.group.position.z = site.cz + Math.sin(v.walkAngle) * v.walkRadius;
                            v.group.position.y = fy;
                            v.group.rotation.y = v.walkAngle + Math.PI / 2;
                            v.group.children[0].position.y = 0.9 + Math.abs(Math.sin(v.armPhase * 0.5)) * 0.05;
                        }   // end if carrying / else walking
                    }   // end outer else (not unpacking)
                } else if (v.phase === 'ladderDown') {
                        // Worker climbs down scaffold ladder — spawn visible ladder once
                        if (!v.ladderSpawned) {
                            v.ladderSpawned = true;
                            const rungMat = new THREE.MeshStandardMaterial({ color: 0x6b7a8d, roughness: 0.4, metalness: 0.7 });
                            const topY = v.group.position.y;
                            v.ladderObjects = [];
                            // Two side rails
                            for (const lx of [-0.22, 0.22]) {
                                const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, topY + 0.2, 6), rungMat);
                                rail.position.set(v.group.position.x + lx, topY / 2, v.group.position.z - 0.1);
                                scene.add(rail); v.ladderObjects.push(rail);
                            }
                            // Rungs every 0.4 units
                            for (let ry = 0.3; ry < topY; ry += 0.4) {
                                const rung = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.05), rungMat);
                                rung.position.set(v.group.position.x, ry, v.group.position.z - 0.1);
                                scene.add(rung); v.ladderObjects.push(rung);
                            }
                        }
                        v.ladderTimer = (v.ladderTimer || 0) + 1;
                        v.armPhase += 0.15;
                        if (v.group.children[4]) v.group.children[4].rotation.z = -0.8 + Math.sin(v.armPhase) * 0.6;
                        if (v.group.children[5]) v.group.children[5].rotation.z = 0.8 + Math.sin(v.armPhase + Math.PI) * 0.6;
                        if (v.group.children[6]) v.group.children[6].rotation.x = Math.sin(v.armPhase) * 0.5;
                        if (v.group.children[7]) v.group.children[7].rotation.x = Math.sin(v.armPhase + Math.PI) * 0.5;
                        if (v.group.position.y > 0.05) {
                            v.group.position.y -= 0.08;
                        } else {
                            v.group.position.y = 0;
                            if (v.group.children[4]) v.group.children[4].rotation.z = -0.4;
                            if (v.group.children[5]) v.group.children[5].rotation.z = 0.4;
                            // Remove ladder
                            if (v.ladderObjects) { v.ladderObjects.forEach(l => scene.remove(l)); v.ladderObjects = null; }
                            v.phase = 'walkOff';
                            v.ladderTimer = 0;
                        }
                        v.group.rotation.y = v.departAngle + Math.PI;
                    } else if (v.phase === 'walkOff') {
                        v.departDist = (v.departDist || 0) + 0.2;
                        v.group.position.x += Math.sin(v.departAngle) * 0.2;
                        v.group.position.z += Math.cos(v.departAngle) * 0.2;
                        v.group.position.y = Math.max(0, v.group.position.y - 0.15);
                        v.group.rotation.y = v.departAngle;
                        v.armPhase += 0.12;
                        if (v.group.children[4]) v.group.children[4].rotation.z = -0.4 + Math.sin(v.armPhase) * 0.5;
                        if (v.group.children[5]) v.group.children[5].rotation.z = 0.4 + Math.sin(v.armPhase + Math.PI) * 0.5;
                        if (v.departDist > 80) { scene.remove(v.group); v.group = null; }
                    }
                }
            });
            // Clean up null vehicles
            constrVehicles = constrVehicles.filter(v => v && v.group);
        }


        // ===== BUILDING TOUR SYSTEM =====
        let tourActive = false;
        let tourSite = null;
        let tourFloor = 0;
        let tourCamProgress = 0; // 0-1 smooth interpolation to target
        let tourTargetPos = new THREE.Vector3();
        let tourTargetLook = new THREE.Vector3();

        function startTour(site) {
            tourActive = true;
            tourSite = site;
            tourFloor = 0;
            controls.enabled = false;
            document.getElementById('tour-overlay').style.display = 'block';
            document.getElementById('btn-constr-tour').style.display = 'none';
            setTourFloor(0);
        }

        function stopTour() {
            tourActive = false;
            tourSite = null;
            controls.enabled = false;
            initFlyCamera();
            document.getElementById('tour-overlay').style.display = 'none';
            const hasDone = constrSites.some(s => s.done);
            if (hasDone) document.getElementById('btn-constr-tour').style.display = '';
        }

        function setTourFloor(f) {
            if (!tourSite) return;
            tourFloor = Math.max(0, Math.min(tourSite.floors - 1, f));
            const floorY = 1.0 + tourFloor * tourSite.floorH + 1.8; // eye height
            const s = tourSite;
            // Position camera inside the building looking toward the windows
            tourTargetPos.set(s.cx, floorY, s.cz);
            tourTargetLook.set(s.cx, floorY, s.cz - s.depth * 0.4);
            const label = document.getElementById('tour-label');
            if (label) {
                const floorNames = ['Ground Floor', '1st Floor', '2nd Floor', '3rd Floor', '4th Floor', '5th Floor', '6th Floor', '7th Floor', '8th Floor', '9th Floor', '10th Floor', '11th Floor'];
                label.textContent = floorNames[tourFloor] || `Floor ${tourFloor + 1}`;
            }
        }

        function updateTour() {
            if (!tourActive || !tourSite) return;
            // Smoothly interpolate camera to floor target
            camera.position.lerp(tourTargetPos, 0.04);
            // Orbit the camera slightly around the floor center for a dynamic feel
            const orbit = Date.now() * 0.0003;
            const lookX = tourSite.cx + Math.sin(orbit) * tourSite.width * 0.3;
            const lookZ = tourSite.cz + Math.cos(orbit) * tourSite.depth * 0.3;
            const lookY = tourTargetPos.y + Math.sin(orbit * 0.5) * 0.3;
            camera.lookAt(lookX, lookY, lookZ);
        }

        function setupTourControls() {
            document.getElementById('btn-tour-next').onclick = () => setTourFloor(tourFloor + 1);
            document.getElementById('btn-tour-prev').onclick = () => setTourFloor(tourFloor - 1);
            document.getElementById('btn-tour-stop').onclick = () => stopTour();
            document.getElementById('btn-constr-tour').onclick = () => {
                // Find the first done site to tour
                const done = constrSites.find(s => s.done);
                if (done) startTour(done);
            };
        }

        // Click on ground near a finished building to select it for tour
        function checkConstrClick(e) {
            if (gameMode !== 'construction' || tourActive || constrPlacing) return;
            const pt = screenToGround(e);
            if (!pt) return;
            for (const site of constrSites) {
                if (!site.done) continue;
                const dx = pt.x - site.cx, dz = pt.z - site.cz;
                if (Math.abs(dx) < site.width * 0.8 && Math.abs(dz) < site.depth * 0.8) {
                    // Show tour button
                    const btn = document.getElementById('btn-constr-tour');
                    btn.style.display = '';
                    btn.textContent = `🎬 Tour Building ${constrSites.indexOf(site) + 1}`;
                    btn.onclick = () => startTour(site);
                    updateConstrStatus(`Building ${constrSites.indexOf(site)+1} complete — click 🎬 Tour to explore inside`);
                    return;
                }
            }
        }

        function showMessage(m) {
            const box = document.getElementById('message-box');
            box.innerText = m; box.style.display = 'block';
            setTimeout(() => box.style.display = 'none', 2000);
        }

        function onWindowResize() {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }

        // ===== GAME MODE SYSTEM =====
        let gameMode = 'menu'; // 'menu', 'simulator', 'survival'

        function setupModeScreens() {
            const startScreen = document.getElementById('start-screen');
            const modeScreen = document.getElementById('mode-screen');
            const header = document.getElementById('header');
            const toolbar = document.getElementById('toolbar');
            const survivalHud = document.getElementById('survival-hud');
            const survivalControls = document.getElementById('survival-controls');

            // Start button → mode select
            document.getElementById('btn-start').onclick = () => {
                startScreen.classList.add('hidden');
                modeScreen.classList.remove('hidden');
            };
            // Back to start
            document.getElementById('btn-back-start').onclick = () => {
                modeScreen.classList.add('hidden');
                startScreen.classList.remove('hidden');
            };

            // Mode: Simulator
            document.getElementById('mode-simulator').onclick = () => {
                modeScreen.classList.add('hidden');
                gameMode = 'simulator';
                header.style.display = '';
                toolbar.style.display = '';
                document.getElementById('construction-hud').classList.add('hidden');
                if (constrActive) exitConstruction();
                exitSurvival();
                clearScene();
                initFlyCamera();
                showMessage('WASD = move  |  Drag = look  |  Q/E = up/down  |  Shift = fast');
            };
            // Mode: Survival
            document.getElementById('mode-survival').onclick = () => {
                modeScreen.classList.add('hidden');
                gameMode = 'survival';
                header.style.display = 'none';
                toolbar.style.display = 'none';
                document.getElementById('construction-hud').classList.add('hidden');
                survivalHud.classList.remove('hidden');
                if (constrActive) exitConstruction();
                clearScene();
                if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
                    survivalControls.classList.add('active');
                }
                enterSurvival();
            };
            // Mode: Construction
            document.getElementById('mode-construction').onclick = () => {
                modeScreen.classList.add('hidden');
                gameMode = 'construction';
                header.style.display = 'none';
                toolbar.style.display = 'none';
                exitSurvival();
                document.getElementById('construction-hud').classList.remove('hidden');
                enterConstruction();   // clearScene is called inside enterConstruction
                initFlyCamera();
                showMessage('WASD = move  |  Drag = look  |  Q/E = up/down  |  Shift = fast');
            };
            document.getElementById('constr-exit').onclick = () => {
                exitConstruction();
                clearScene();
                document.getElementById('construction-hud').classList.add('hidden');
                document.getElementById('btn-constr-add').textContent = '+ Add Building';
                gameMode = 'menu';
                modeScreen.classList.remove('hidden');
            };
            document.getElementById('btn-constr-add').onclick = () => {
                if (constrPlacing) {
                    cancelConstrPlacement();
                    document.getElementById('btn-constr-add').textContent = '+ Add Building';
                } else {
                    startConstrPlacement();
                    document.getElementById('btn-constr-add').textContent = '✕ Cancel';
                }
            };
            document.getElementById('btn-constr-speed').onclick = function() {
                constrSpeed = constrSpeed === 1 ? 2 : constrSpeed === 2 ? 4 : 1;
                this.textContent = constrSpeed === 1 ? '⏩ 2× Speed' : constrSpeed === 2 ? '⏩ 4× Speed' : '▶ 1× Speed';
                setConstructionSpeed(constrSpeed);
            };

            // Survival HUD: exit
            document.getElementById('survival-exit').onclick = () => {
                gameMode = 'menu';
                exitSurvival();
                survivalHud.classList.add('hidden');
                survivalControls.classList.remove('active');
                header.style.display = 'none';
                toolbar.style.display = 'none';
                modeScreen.classList.remove('hidden');
            };

            // Touch movement buttons fire pseudo-key events
            survivalControls.querySelectorAll('.move-btn').forEach(btn => {
                const key = btn.getAttribute('data-key');
                btn.addEventListener('pointerdown', e => {
                    e.preventDefault();
                    survivalKeys[key] = true;
                });
                btn.addEventListener('pointerup', e => {
                    e.preventDefault();
                    survivalKeys[key] = false;
                    if (key === 'KeyE') {
                        survivalActionPressed = false;
                        survivalChopProgress = 0;
                        survivalChopTarget = null;
                    }
                });
                btn.addEventListener('pointercancel', e => {
                    survivalKeys[key] = false;
                    if (key === 'KeyE') {
                        survivalActionPressed = false;
                        survivalChopProgress = 0;
                        survivalChopTarget = null;
                    }
                });
                btn.addEventListener('pointerleave', e => {
                    survivalKeys[key] = false;
                    if (key === 'KeyE') {
                        survivalActionPressed = false;
                        survivalChopProgress = 0;
                        survivalChopTarget = null;
                    }
                });
            });
        }

        // ===== SURVIVAL MODE =====
        let survivalKeys = {};
        let grassPatches = [];

        function spawnGrass() {
            clearGrass();
            // Use InstancedMesh for performance: thousands of grass blades
            const bladeGeo = new THREE.PlaneGeometry(0.3, 0.7);
            // Move pivot to bottom so the blade roots in the ground
            bladeGeo.translate(0, 0.35, 0);
            const grassMat = new THREE.MeshStandardMaterial({
                color: 0x4a7c2e,
                side: THREE.DoubleSide,
                roughness: 1,
                transparent: true,
                alphaTest: 0.5
            });
            const grassMatLight = new THREE.MeshStandardMaterial({
                color: 0x6ba84f,
                side: THREE.DoubleSide,
                roughness: 1,
                transparent: true,
                alphaTest: 0.5
            });
            const count = 4000;
            const inst1 = new THREE.InstancedMesh(bladeGeo, grassMat, count);
            const inst2 = new THREE.InstancedMesh(bladeGeo, grassMatLight, count);
            const dummy = new THREE.Object3D();
            for (let i = 0; i < count; i++) {
                // Random position within world boundary
                const angle = Math.random() * Math.PI * 2;
                const r = Math.sqrt(Math.random()) * (WORLD_SIZE - 6);
                const x = Math.cos(angle) * r;
                const z = Math.sin(angle) * r;
                dummy.position.set(x, 0, z);
                dummy.rotation.y = Math.random() * Math.PI * 2;
                const s = 0.7 + Math.random() * 0.6;
                dummy.scale.set(s, s, s);
                dummy.updateMatrix();
                inst1.setMatrixAt(i, dummy.matrix);

                // Second pass at offset position with lighter color
                dummy.position.set(x + (Math.random() - 0.5) * 1.5, 0, z + (Math.random() - 0.5) * 1.5);
                dummy.rotation.y = Math.random() * Math.PI * 2;
                dummy.updateMatrix();
                inst2.setMatrixAt(i, dummy.matrix);
            }
            inst1.instanceMatrix.needsUpdate = true;
            inst2.instanceMatrix.needsUpdate = true;
            scene.add(inst1);
            scene.add(inst2);
            grassPatches.push(inst1);
            grassPatches.push(inst2);
        }

        function clearGrass() {
            grassPatches.forEach(g => {
                scene.remove(g);
                if (g.geometry) g.geometry.dispose();
                if (g.material) g.material.dispose();
            });
            grassPatches = [];
        }

        let survivalHp = 100;
        let survivalWood = 0;
        let survivalChopProgress = 0;
        let survivalChopTarget = null;
        let survivalActionPressed = false;
        let survivalVelY = 0; // vertical velocity for tornado lift / falling
        let survivalCaughtInTornado = false; // true while being pulled in
        let survivalSwirlAngle = 0; // current swirl orbit angle around the tornado center
        let survivalStartTime = 0;
        let savedCameraPos = null;
        let savedCameraTarget = null;
        let savedControlsEnabled = true;
        let nextDisasterTime = 0;
        let survivalActive = false;
        let lastDamageTime = 0;
        const SURVIVAL_EYE_HEIGHT = 2.5;
        const SURVIVAL_MOVE_SPEED = 0.32; // villager walking pace

        // Player avatar group (third-person)
        let survivalPlayer = null;

        function buildSurvivalPlayer() {
            const group = new THREE.Group();
            const skinMat = new THREE.MeshStandardMaterial({ color: 0xf5d0a9, roughness: 0.85 });
            const shirtMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.95 });
            const pantsMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.95 });
            const hairMat = new THREE.MeshStandardMaterial({ color: 0x3b2412, roughness: 0.9 });

            // Torso
            const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 1.0, 8), shirtMat);
            torso.position.y = 1.2;
            torso.castShadow = true;
            group.add(torso);

            // Head
            const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), skinMat);
            head.position.y = 2.0;
            head.castShadow = true;
            group.add(head);

            // Hair cap
            const hair = new THREE.Mesh(
                new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
                hairMat
            );
            hair.position.y = 2.05;
            group.add(hair);

            // Eyes (small black dots)
            for (const ex of [-0.13, 0.13]) {
                const eye = new THREE.Mesh(
                    new THREE.SphereGeometry(0.05, 6, 5),
                    new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
                );
                eye.position.set(ex, 2.0, 0.32);
                group.add(eye);
            }

            // Arms (with pivot for swing)
            function makeArm(side) {
                const armPivot = new THREE.Group();
                armPivot.position.set(side * 0.55, 1.6, 0);
                const upper = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.13, 0.14, 0.55, 6),
                    shirtMat
                );
                upper.position.y = -0.3;
                upper.castShadow = true;
                armPivot.add(upper);
                const hand = new THREE.Mesh(
                    new THREE.SphereGeometry(0.13, 8, 6),
                    skinMat
                );
                hand.position.y = -0.65;
                armPivot.add(hand);
                group.add(armPivot);
                return armPivot;
            }
            const armL = makeArm(-1);
            const armR = makeArm(1);

            // Legs (with pivot for walk)
            function makeLeg(side) {
                const legPivot = new THREE.Group();
                legPivot.position.set(side * 0.2, 0.7, 0);
                const upper = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.16, 0.18, 0.7, 6),
                    pantsMat
                );
                upper.position.y = -0.4;
                upper.castShadow = true;
                legPivot.add(upper);
                const foot = new THREE.Mesh(
                    new THREE.BoxGeometry(0.25, 0.12, 0.4),
                    new THREE.MeshStandardMaterial({ color: 0x1a1a1a })
                );
                foot.position.set(0, -0.78, 0.05);
                legPivot.add(foot);
                group.add(legPivot);
                return legPivot;
            }
            const legL = makeLeg(-1);
            const legR = makeLeg(1);

            group.userData = {
                armL, armR, legL, legR,
                walkPhase: 0,
                isPlayer: true
            };
            return group;
        }

        function enterSurvival() {
            survivalActive = true;
            survivalHp = 100;
            survivalWood = 0;
            survivalChopProgress = 0;
            survivalChopTarget = null;
            survivalVelY = 0;
            survivalCaughtInTornado = false;
            survivalStartTime = performance.now();
            nextDisasterTime = performance.now() + 4000;

            // Save current camera state so we can restore on exit
            savedCameraPos = camera.position.clone();
            savedCameraTarget = controls.target.clone();
            savedControlsEnabled = controls.enabled;

            // Create player avatar — kept as a tracker but hidden in first person
            if (!survivalPlayer) survivalPlayer = buildSurvivalPlayer();
            survivalPlayer.position.set(0, 0, 0);
            survivalPlayer.rotation.y = Math.PI;
            survivalPlayer.visible = false; // first person — avatar invisible
            scene.add(survivalPlayer);

            // Initialize yaw/pitch
            survivalYaw = Math.PI;
            survivalPitch = 0; // looking straight ahead
            updateFirstPersonCamera();
            controls.enabled = false;

            // Grass is already in scene from init / terrain gen

            // Input listeners
            window.addEventListener('keydown', survivalKeyDown);
            window.addEventListener('keyup', survivalKeyUp);
            renderer.domElement.addEventListener('pointerdown', survivalPointerDown);
            window.addEventListener('pointermove', survivalPointerMove);
            window.addEventListener('pointerup', survivalPointerUp);

            updateSurvivalHud();
            // Crosshair not needed in third-person view

            // Auto-spawn a starter scene if none exists
            if (worldObjects.filter(o => o.userData.type === 'house').length < 3) {
                generateTerrain();
                for (let i = 0; i < 4; i++) {
                    const ang = (i / 4) * Math.PI * 2 + Math.random() * 0.4;
                    const r = 12 + Math.random() * 18;
                    placeObject('house', new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
                }
                // Re-spawn grass after terrain regen
                spawnGrass();
            }
        }

        function exitSurvival() {
            survivalActive = false;
            window.removeEventListener('keydown', survivalKeyDown);
            window.removeEventListener('keyup', survivalKeyUp);
            if (renderer && renderer.domElement) {
                renderer.domElement.removeEventListener('pointerdown', survivalPointerDown);
            }
            window.removeEventListener('pointermove', survivalPointerMove);
            window.removeEventListener('pointerup', survivalPointerUp);
            survivalKeys = {};
            survivalDragging = false;

            // Hide UI elements
            document.getElementById('survival-crosshair').classList.remove('visible');
            document.getElementById('survival-prompt').classList.remove('visible');

            // Remove player avatar
            if (survivalPlayer && survivalPlayer.parent) {
                scene.remove(survivalPlayer);
            }

            // Keep grass in scene

            // Restore camera if we saved one
            if (savedCameraPos) {
                camera.position.copy(savedCameraPos);
                controls.target.copy(savedCameraTarget);
                controls.enabled = savedControlsEnabled;
                savedCameraPos = null;
            }
            // Hide death overlay if visible
            const msg = document.getElementById('survival-message');
            msg.classList.remove('visible');
        }

        // ===== MOUSE LOOK =====
        let survivalYaw = 0;     // horizontal rotation (radians)
        let survivalPitch = 0;   // vertical rotation
        let survivalDragging = false;
        let survivalLastPointer = { x: 0, y: 0 };
        const SURVIVAL_LOOK_SENS = 0.0035;

        // First-person camera: ride at the player's eye height, with subtle head bob while walking
        const FIRST_PERSON_EYE = 2.4;
        let survivalBobPhase = 0;
        let survivalIsWalking = false;
        function updateFirstPersonCamera() {
            if (!survivalPlayer) return;

            // Vertical head bob only (no lateral) — minimal so it doesn't feel orbital
            let bobY = 0;
            if (survivalIsWalking) {
                survivalBobPhase += 0.18;
                bobY = Math.abs(Math.sin(survivalBobPhase)) * 0.08;
            } else {
                survivalBobPhase = 0;
            }

            // Snap camera directly to the player's eye position. No lerp — the camera
            // IS the player. This guarantees movement keys translate the camera 1:1
            // and rotation pivots exactly around the camera position.
            camera.position.set(
                survivalPlayer.position.x,
                survivalPlayer.position.y + FIRST_PERSON_EYE + bobY,
                survivalPlayer.position.z
            );

            // Look direction from yaw + pitch
            const dir = new THREE.Vector3(
                Math.sin(survivalYaw) * Math.cos(survivalPitch),
                Math.sin(survivalPitch),
                Math.cos(survivalYaw) * Math.cos(survivalPitch)
            );
            const target = camera.position.clone().add(dir);
            camera.lookAt(target);
        }

        // Legacy alias points to first-person updater now
        function updateThirdPersonCamera() { updateFirstPersonCamera(); }

        function applySurvivalCameraRotation() {
            updateFirstPersonCamera();
        }

        function survivalPointerDown(e) {
            if (e.target.closest('#survival-hud') || e.target.closest('#survival-controls')) return;
            survivalDragging = true;
            survivalLastPointer.x = e.clientX;
            survivalLastPointer.y = e.clientY;
            try { renderer.domElement.setPointerCapture(e.pointerId); } catch(_) {}
        }

        function survivalPointerMove(e) {
            if (!survivalDragging || !survivalActive) return;
            const dx = e.clientX - survivalLastPointer.x;
            const dy = e.clientY - survivalLastPointer.y;
            survivalLastPointer.x = e.clientX;
            survivalLastPointer.y = e.clientY;

            survivalYaw -= dx * SURVIVAL_LOOK_SENS;
            survivalPitch -= dy * SURVIVAL_LOOK_SENS;
            // Clamp so player can't flip backward
            const maxPitch = Math.PI / 2 - 0.15;
            if (survivalPitch > maxPitch) survivalPitch = maxPitch;
            if (survivalPitch < -maxPitch) survivalPitch = -maxPitch;

            applySurvivalCameraRotation();
        }

        function survivalPointerUp(e) {
            survivalDragging = false;
        }

        function survivalKeyDown(e) {
            const k = e.key.toLowerCase();
            let mapped = null;
            if (k === 'arrowup')    mapped = 'ArrowUp';
            else if (k === 'arrowdown')  mapped = 'ArrowDown';
            else if (k === 'arrowleft')  mapped = 'ArrowLeft';
            else if (k === 'arrowright') mapped = 'ArrowRight';
            if (mapped) {
                survivalKeys[mapped] = true;
                e.preventDefault();
                return;
            }
            if (k === 'e') {
                survivalKeys['KeyE'] = true;
                e.preventDefault();
            }
        }
        function survivalKeyUp(e) {
            const k = e.key.toLowerCase();
            let mapped = null;
            if (k === 'arrowup')    mapped = 'ArrowUp';
            else if (k === 'arrowdown')  mapped = 'ArrowDown';
            else if (k === 'arrowleft')  mapped = 'ArrowLeft';
            else if (k === 'arrowright') mapped = 'ArrowRight';
            if (mapped) {
                survivalKeys[mapped] = false;
                return;
            }
            if (k === 'e') {
                survivalKeys['KeyE'] = false;
                survivalActionPressed = false;
                survivalChopProgress = 0;
                survivalChopTarget = null;
            }
        }

        function updateSurvival() {
            if (!survivalActive || !survivalPlayer) return;
            const now = performance.now();

            // Forward = direction from yaw (XZ only). Right = perpendicular.
            const forward = new THREE.Vector3(Math.sin(survivalYaw), 0, Math.cos(survivalYaw));
            const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

            // Aggregate movement input into a vector (so diagonals don't double-speed)
            const moveDir = new THREE.Vector3();
            let isMoving = false;
            if (!survivalCaughtInTornado) {
                if (survivalKeys['ArrowUp'])    { moveDir.add(forward); isMoving = true; }
                if (survivalKeys['ArrowDown'])  { moveDir.sub(forward); isMoving = true; }
                if (survivalKeys['ArrowLeft'])  { moveDir.sub(right);   isMoving = true; }
                if (survivalKeys['ArrowRight']) { moveDir.add(right);   isMoving = true; }
                if (isMoving) {
                    moveDir.normalize().multiplyScalar(SURVIVAL_MOVE_SPEED);
                    survivalPlayer.position.x += moveDir.x;
                    survivalPlayer.position.z += moveDir.z;
                }
            }
            // Update walking state for the head-bob system
            survivalIsWalking = isMoving;

            // Rotate the player to face the camera's yaw direction
            survivalPlayer.rotation.y = survivalYaw + Math.PI; // body faces forward direction

            // Animate legs/arms when moving
            const legL = survivalPlayer.userData.legL;
            const legR = survivalPlayer.userData.legR;
            const armL = survivalPlayer.userData.armL;
            const armR = survivalPlayer.userData.armR;
            if (isMoving) {
                survivalPlayer.userData.walkPhase += 0.3;
                const phase = Math.sin(survivalPlayer.userData.walkPhase);
                legL.rotation.x = phase * 0.6;
                legR.rotation.x = -phase * 0.6;
                armL.rotation.x = -phase * 0.4;
                armR.rotation.x = phase * 0.4;
            } else {
                // Smoothly return to rest
                legL.rotation.x *= 0.85;
                legR.rotation.x *= 0.85;
                armL.rotation.x *= 0.85;
                armR.rotation.x *= 0.85;
            }

            // Tornado pull: check if any tornado is close enough
            const playerPos2 = new THREE.Vector3(survivalPlayer.position.x, 0, survivalPlayer.position.z);
            let nearestTornado = null, nearestTornadoD = Infinity;
            tornadoes.forEach(t => {
                if (t.age > 400) return;
                const d = playerPos2.distanceTo(t.point);
                if (d < 80 && d < nearestTornadoD) {
                    nearestTornadoD = d;
                    nearestTornado = t;
                }
            });

            if (nearestTornado) {
                survivalCaughtInTornado = nearestTornadoD < 60;
                if (survivalCaughtInTornado) {
                    const t = nearestTornado;
                    const dx = survivalPlayer.position.x - t.point.x;
                    const dz = survivalPlayer.position.z - t.point.z;
                    const d = Math.sqrt(dx*dx + dz*dz);
                    const closeness = 1 - d / 60;
                    if (d > 0.5) {
                        const tan = new THREE.Vector3(-dz, 0, dx).normalize();
                        const pull = new THREE.Vector3(-dx, 0, -dz).normalize();
                        survivalPlayer.position.addScaledVector(tan, 0.6 * closeness);
                        survivalPlayer.position.addScaledVector(pull, 0.25 * closeness);
                    }
                    const lift = 0.18 * Math.max(0.5, closeness);
                    survivalVelY += lift;
                    survivalVelY = Math.min(survivalVelY, 0.8);
                    if (now - lastDamageTime > 150) {
                        survivalHp -= 4;
                        lastDamageTime = now;
                    }
                }
            } else {
                survivalCaughtInTornado = false;
            }

            // Apply vertical velocity + gravity
            survivalPlayer.position.y += survivalVelY;
            survivalVelY -= 0.04;
            if (survivalPlayer.position.y <= 0) {
                if (survivalVelY < -0.6) {
                    const fallDmg = Math.floor((-survivalVelY - 0.6) * 25);
                    if (fallDmg > 0) {
                        survivalHp -= fallDmg;
                        showSurvivalToast(`-${fallDmg} HP (fall)`);
                    }
                }
                survivalPlayer.position.y = 0;
                survivalVelY = 0;
            }

            // Clamp to world boundary
            const dfo = Math.sqrt(survivalPlayer.position.x ** 2 + survivalPlayer.position.z ** 2);
            if (dfo > WORLD_SIZE - 5) {
                survivalPlayer.position.x *= (WORLD_SIZE - 5) / dfo;
                survivalPlayer.position.z *= (WORLD_SIZE - 5) / dfo;
            }

            // Update camera to follow
            updateThirdPersonCamera();

            // === INTERACTION ===
            survivalUpdateInteraction();

            // === DISASTERS ===
            if (now > nextDisasterTime) {
                triggerRandomSurvivalDisaster();
                nextDisasterTime = now + 5000 + Math.random() * 7000;
            }

            // === DAMAGE FROM ENVIRONMENT ===
            const playerPos = new THREE.Vector3(survivalPlayer.position.x, 0, survivalPlayer.position.z);
            let inDanger = false;
            // Fires
            worldObjects.forEach(o => {
                if (o.userData.onFire && !o.userData.isCorpse) {
                    if (o.position.distanceTo(playerPos) < 6) inDanger = true;
                }
            });
            // Lava pools
            volcanoes.forEach(v => {
                const d = playerPos.distanceTo(new THREE.Vector3(v.point.x, 0, v.point.z));
                if (d < v.poolRadius && d > v.radius * 0.6) inDanger = true;
            });
            // Tsunamis
            tsunamis.forEach(w => {
                const dx = playerPos.x - w.position;
                if (Math.abs(dx) < 20) inDanger = true;
            });
            // Singularity
            if (singularityPoint) {
                if (playerPos.distanceTo(singularityPoint) < 50) inDanger = true;
            }
            // Active explosion debris (recently spawned, fast-moving rubble = dangerous)
            debris.forEach(d => {
                if (d.userData && !d.userData.settled && d.position.distanceTo(playerPos) < 3) {
                    inDanger = true;
                }
            });

            if (inDanger && now - lastDamageTime > 200) {
                survivalHp -= 8;
                lastDamageTime = now;
                showSurvivalToast('-8 HP');
            }

            // === INVADER ATTACKS PLAYER ===
            // Crossbow bolts that hit the player. Cap at one bolt-hit per frame to prevent insta-kill.
            for (let i = crossbowBolts.length - 1; i >= 0; i--) {
                const b = crossbowBolts[i];
                if (b.position.distanceTo(survivalPlayer.position) < 2.0 && b.position.y < 4) {
                    survivalHp -= 35;
                    if (b.userData.flaming) survivalHp -= 10;
                    scene.remove(b);
                    crossbowBolts.splice(i, 1);
                    showSurvivalToast('-35 HP (bolt)');
                    break; // only one bolt-hit per frame
                }
            }
            // Direct contact with invader (mounted invader can run you over)
            worldObjects.forEach(o => {
                if (o.userData.type !== 'invader') return;
                if (o.userData.hp <= 0 || o.userData.isCorpse) return;
                if (o.position.distanceTo(playerPos) < 2.5) {
                    if (now - lastDamageTime > 250) {
                        survivalHp -= o.userData.mounted ? 15 : 8;
                        lastDamageTime = now;
                    }
                }
            });

            // === LAVA BOMBS hitting near player ===
            for (const b of lavaBombs) {
                if (b.position.distanceTo(survivalPlayer.position) < 4 && b.position.y < 5) {
                    if (now - lastDamageTime > 200) {
                        survivalHp -= 25;
                        lastDamageTime = now;
                    }
                    break; // only one bomb damage per frame
                }
            }

            // Always update HUD first so the player sees their HP drop to 0 before the death screen
            updateSurvivalHud();

            if (survivalHp <= 0) {
                survivalDeath();
                return;
            }
        }

        function updateSurvivalHud() {
            const hpEl = document.getElementById('survival-hp');
            const hpBar = document.getElementById('survival-hpbar');
            const timeEl = document.getElementById('survival-time');
            const woodEl = document.getElementById('survival-wood');
            if (hpEl) hpEl.innerText = Math.max(0, Math.round(survivalHp));
            if (hpBar) hpBar.style.width = Math.max(0, survivalHp) + '%';
            if (woodEl) woodEl.innerText = survivalWood;
            if (timeEl) {
                const elapsed = Math.floor((performance.now() - survivalStartTime) / 1000);
                timeEl.innerText = elapsed + 's';
            }
        }

        // Find what the player is looking at within 6 units in front
        function survivalUpdateInteraction() {
            if (!survivalPlayer) return;
            const prompt = document.getElementById('survival-prompt');
            // Forward vector
            const forward = new THREE.Vector3(Math.sin(survivalYaw), 0, Math.cos(survivalYaw));
            const playerPos = new THREE.Vector3(survivalPlayer.position.x, 0, survivalPlayer.position.z);
            const reach = 6;

            // Find nearest standing tree along forward ray within reach
            let bestTree = null, bestT = Infinity;
            worldObjects.forEach(other => {
                if (other.userData.type !== 'tree') return;
                if (other.userData.hp <= 0) return;
                if (other.userData.skeleton) return;
                if (other.userData.hasFallen || other.userData.isFalling) return;
                const toObj = new THREE.Vector3().subVectors(other.position, playerPos);
                const dist = toObj.length();
                if (dist > reach + 1) return;
                // Project onto forward
                const along = toObj.dot(forward);
                if (along < 0 || along > reach) return;
                // Lateral distance
                const lateral = Math.sqrt(dist * dist - along * along);
                if (lateral > 1.6) return;
                if (along < bestT) { bestT = along; bestTree = other; }
            });

            const isHolding = !!survivalKeys['KeyE'];

            if (bestTree) {
                if (isHolding) {
                    // Chopping
                    if (survivalChopTarget !== bestTree) {
                        survivalChopTarget = bestTree;
                        survivalChopProgress = 0;
                    }
                    survivalChopProgress += 1;
                    prompt.innerText = `🪓 Chopping... ${Math.min(100, Math.round((survivalChopProgress / 90) * 100))}%`;
                    prompt.classList.add('visible');
                    // Wiggle the tree
                    bestTree.rotation.z = Math.sin(survivalChopProgress * 0.5) * 0.05;
                    if (survivalChopProgress >= 90) {
                        // Fell the tree
                        bestTree.userData.isFalling = true;
                        bestTree.userData.fallAxis = new THREE.Vector3(
                            bestTree.position.x - playerPos.x,
                            0,
                            bestTree.position.z - playerPos.z
                        ).normalize();
                        bestTree.userData.fallAngle = 0;
                        bestTree.userData.hp = 9999;
                        survivalWood += 2;
                        survivalChopProgress = 0;
                        survivalChopTarget = null;
                        showSurvivalToast('+2 🪵 Wood');
                        updateSurvivalHud();
                    }
                } else {
                    survivalChopProgress = 0;
                    survivalChopTarget = null;
                    prompt.innerText = '🪓 Hold E to chop';
                    prompt.classList.add('visible');
                }
                return;
            } else {
                survivalChopProgress = 0;
                survivalChopTarget = null;
            }

            // No tree in range — check if player has wood and is looking at empty ground
            if (survivalWood >= 2) {
                // Compute placement point in front of player
                const placePos = new THREE.Vector3(
                    playerPos.x + forward.x * 4,
                    0,
                    playerPos.z + forward.z * 4
                );
                // Check that no other object is too close to that spot
                let blocked = false;
                worldObjects.forEach(other => {
                    if (other === bestTree) return;
                    if (other.position.distanceTo(placePos) < 3) blocked = true;
                });
                if (!blocked) {
                    if (isHolding && !survivalActionPressed) {
                        // Place barrier (one-shot on press, not hold)
                        survivalActionPressed = true;
                        placeSurvivalBarrier(placePos, forward);
                        survivalWood -= 2;
                        showSurvivalToast('Barrier placed (-2 🪵)');
                        updateSurvivalHud();
                        prompt.classList.remove('visible');
                        return;
                    }
                    prompt.innerText = '🧱 Press E to place barrier (2 🪵)';
                    prompt.classList.add('visible');
                    return;
                }
            }

            // Nothing to interact with
            prompt.classList.remove('visible');
        }

        function placeSurvivalBarrier(pos, forward) {
            const group = new THREE.Group();
            // Wooden barrier — 4 vertical posts and 2 horizontal planks
            const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.95 });
            const darkWoodMat = new THREE.MeshStandardMaterial({ color: 0x5a3b1a, roughness: 1 });
            const width = 6;
            const height = 3.5;
            // Posts
            for (const dx of [-width/2, -1, 1, width/2]) {
                const post = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.2, 0.25, height, 6),
                    darkWoodMat
                );
                post.position.set(dx, height/2, 0);
                post.castShadow = true;
                group.add(post);
                // Sharpened tip
                const tip = new THREE.Mesh(
                    new THREE.ConeGeometry(0.25, 0.5, 5),
                    darkWoodMat
                );
                tip.position.set(dx, height + 0.25, 0);
                group.add(tip);
            }
            // Horizontal planks
            for (const dy of [1.0, 2.4]) {
                const plank = new THREE.Mesh(
                    new THREE.BoxGeometry(width + 0.4, 0.3, 0.2),
                    woodMat
                );
                plank.position.set(0, dy, 0);
                plank.castShadow = true;
                group.add(plank);
            }

            // Orient the barrier perpendicular to the player's forward direction
            // (so the wall faces the player). Forward is in XZ plane.
            const yaw = Math.atan2(forward.x, forward.z);
            // The barrier's wall plane is its X axis; we want X perpendicular to forward,
            // so rotate by yaw + π/2.
            group.rotation.y = yaw + Math.PI / 2;
            group.position.copy(pos);

            group.userData = {
                type: 'barrier',
                hp: 200,
                maxHp: 200,
                velocity: new THREE.Vector3(),
                onFire: false,
                burnLevel: 0,
                isStatic: true,
                lifeTime: 0
            };
            scene.add(group);
            worldObjects.push(group);
        }

        function showSurvivalToast(text) {
            const msg = document.getElementById('survival-message');
            msg.innerText = text;
            msg.style.background = 'rgba(34, 197, 94, 0.9)';
            msg.style.fontSize = '1.4rem';
            msg.style.padding = '16px 30px';
            msg.classList.add('visible');
            setTimeout(() => {
                msg.classList.remove('visible');
                // Restore default styling for warnings
                msg.style.background = '';
                msg.style.fontSize = '';
                msg.style.padding = '';
            }, 1500);
        }

        function triggerRandomSurvivalDisaster() {
            // Pick a random disaster targeting near the player
            const ppos = survivalPlayer ? survivalPlayer.position : new THREE.Vector3(0,0,0);
            const playerPos = new THREE.Vector3(ppos.x, 0, ppos.z);
            // 10% chance the disaster lands right next to the player; otherwise nearby for fleeing
            const direct = Math.random() < 0.1;
            const ang = Math.random() * Math.PI * 2;
            const dist = direct ? 5 + Math.random() * 8 : 30 + Math.random() * 50;
            const targetPt = new THREE.Vector3(
                playerPos.x + Math.cos(ang) * dist,
                0,
                playerPos.z + Math.sin(ang) * dist
            );
            // Clamp inside world
            const distFromOrigin = Math.sqrt(targetPt.x ** 2 + targetPt.z ** 2);
            if (distFromOrigin > WORLD_SIZE - 10) {
                targetPt.multiplyScalar((WORLD_SIZE - 10) / distFromOrigin);
            }

            const choices = [
                'meteor', 'tornado', 'volcano', 'tsunami', 'fire',
                'cluster', 'napalm', 'invader', 'invader', 'invader' // invaders weighted higher
            ];
            const choice = choices[Math.floor(Math.random() * choices.length)];

            if (choice === 'meteor') {
                launchMeteor(targetPt);
            } else if (choice === 'tornado') {
                spawnTornado(targetPt);
            } else if (choice === 'volcano') {
                spawnVolcano(targetPt);
            } else if (choice === 'tsunami') {
                spawnTsunami(targetPt);
            } else if (choice === 'fire') {
                igniteRadius(targetPt, 16);
                explode(targetPt, 12, 0xff7700);
            } else if (choice === 'cluster') {
                executeWeapon('cluster', targetPt);
            } else if (choice === 'napalm') {
                executeWeapon('napalm', targetPt);
            } else if (choice === 'invader') {
                // Spawn 2-4 invaders at the world edge, charging the player
                const count = 2 + Math.floor(Math.random() * 3);
                const edgeAng = ang;
                for (let i = 0; i < count; i++) {
                    const a = edgeAng + (Math.random() - 0.5) * 0.8;
                    const r = WORLD_SIZE * 0.85;
                    placeObject('invader', new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
                }
            }

            // Show a warning
            const msg = document.getElementById('survival-message');
            msg.innerText = '⚠️ ' + choice.toUpperCase();
            msg.classList.add('visible');
            setTimeout(() => msg.classList.remove('visible'), 1500);
        }

        function survivalDeath() {
            if (!survivalActive) return; // already dead
            survivalActive = false;
            const elapsed = Math.floor((performance.now() - survivalStartTime) / 1000);
            const msg = document.getElementById('survival-message');
            msg.innerHTML = '💀 You died<br><span style="font-size:1.1rem;font-weight:normal">Survived ' + elapsed + 's</span>';
            msg.classList.add('visible');
            setTimeout(() => {
                msg.classList.remove('visible');
                document.getElementById('survival-exit').click();
            }, 3500);
        }

        // Bootstrapping: don't run init() immediately. Wait for a Start click.
        function bootstrap() {
            setupModeScreens();
            init();
            setupFlyCameraEvents();
            setupTourControls();
        }

let bootstrapped = false;
export function startSimulator() {
    if (bootstrapped) return;
    bootstrapped = true;
    bootstrap();
}
