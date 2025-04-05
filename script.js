/**
 * Infinite Bullet Hell - Multiplayer Game Script
 */

import { createNoise2D } from 'simplex-noise';

// --- DOM Elements ---
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');
const leaderboardList = document.getElementById('leaderboard-list');
const healthBarFill = document.getElementById('health-bar-fill');
const healthText = document.getElementById('health-text');
const topLeftUiContainer = document.getElementById('top-left-ui');
const toggleUiButton = document.getElementById('toggle-ui-button');
const respawnPrompt = document.getElementById('respawn-prompt');
const respawnButton = document.getElementById('respawn-button');

// --- Game Constants ---
const CHUNK_SIZE = 512; // Size of each chunk in pixels
const PLAYER_RADIUS = 10;
const BULLET_RADIUS = 5;
const MAX_SPEED = 3;
const MAX_HEALTH = 100;
const HEALTH_REGEN_RATE = 2; // Health points per second
const BULLET_DAMAGE = 15; // Base damage per bullet hit
const DODGER_BULLET_DAMAGE = 10; // Damage for dodger bullets
const EXPLOSION_DURATION = 0.3; // seconds
const EXPLOSION_RADIUS = 30; // Max radius of explosion effect
const RESURRECT_RANGE = PLAYER_RADIUS * 4; // How close player needs to be to click-resurrect someone
const CLICK_DETECTION_RADIUS = PLAYER_RADIUS * 2; // How close click needs to be to dead player body
const SPAWN_CHUNK_RADIUS = 2; // Defines the spawn area radius around (0,0). 2 => -2 to 1 range (4x4 chunks)

// --- Websim ---
const room = new WebsimSocket();

// --- Game State ---
let localPlayer = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  score: 0,
  timeOutsideSpawnMs: 0, // Track time spent outside spawn chunk for scoring
  health: MAX_HEALTH,
  maxHealth: MAX_HEALTH,
  lastUpdateTime: Date.now(),
  dead: false,
};

let players = {}; // Store other players' data { clientId: { x, y, username, avatarUrl, score, health, maxHealth, dead } }
let localChunks = {}; // Store chunk data generated locally { 'x_y': { npcs: [...], obstacles: [...] } }
let remoteChunks = {}; // Store chunk data received from peers for conflict checks { 'x_y': { clientId: chunkData } }
let bullets = []; // { x, y, vx, vy, ownerChunkX, ownerChunkY, type: 'shooter' | 'dodger', remote?: boolean }
let explosions = []; // { x, y, startTime, maxRadius }
let camera = { x: 0, y: 0, zoom: 1 }; // Added zoom capability (optional)
let keys = {}; // Keyboard input state
const noise2D = createNoise2D(); // For deterministic chunk generation

// --- Helper Functions ---

/**
 * Checks if a chunk coordinate pair is within the defined spawn area.
 * Spawn area is defined from -SPAWN_CHUNK_RADIUS to SPAWN_CHUNK_RADIUS - 1.
 * e.g., SPAWN_CHUNK_RADIUS = 1 --> range -1 to 0 (2x2 chunks: -1,-1; -1,0; 0,-1; 0,0)
 * e.g., SPAWN_CHUNK_RADIUS = 2 --> range -2 to 1 (4x4 chunks)
 */
function isSpawnChunk(chunkX, chunkY) {
    const minCoord = -SPAWN_CHUNK_RADIUS;
    const maxCoord = SPAWN_CHUNK_RADIUS - 1;
    return chunkX >= minCoord && chunkX <= maxCoord && chunkY >= minCoord && chunkY <= maxCoord;
}

/**
 * Converts screen coordinates (e.g., from mouse click) to world coordinates.
 */
function screenToWorldCoords(screenX, screenY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    // Adjust for camera position and potential zoom
    const worldX = (screenX - rect.left) * scaleX / camera.zoom + (camera.x - canvas.width / (2 * camera.zoom));
    const worldY = (screenY - rect.top) * scaleY / camera.zoom + (camera.y - canvas.height / (2 * camera.zoom));

    return { x: worldX, y: worldY };
}

/**
 * Generates a consistent color based on a client ID string.
 */
function getPlayerColor(clientId) {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
        hash = clientId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const color = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - color.length) + color;
}

// --- Game Initialization ---

async function initializeGame() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  toggleUiButton.addEventListener('click', toggleUiVisibility);
  respawnButton.addEventListener('click', handleRespawnButtonClick);
  canvas.addEventListener('click', handleCanvasClick); // For resurrection

  await room.initialize();

  // Initial player state from potential room state (e.g., dynamic spawn)
  localPlayer.x = room.roomState.spawnX || 0;
  localPlayer.y = room.roomState.spawnY || 0;
  localPlayer.health = MAX_HEALTH; // Start with full health
  localPlayer.dead = false; // Ensure not dead initially
  localPlayer.score = 0; // Reset score
  localPlayer.timeOutsideSpawnMs = 0; // Reset score timer

  room.updatePresence({
    x: localPlayer.x,
    y: localPlayer.y,
    score: localPlayer.score,
    health: localPlayer.health,
    maxHealth: localPlayer.maxHealth,
    dead: localPlayer.dead,
  });

  loadChunksFromLocalStorage(); // Load previously explored chunks

  // Subscribe to Websim updates
  room.subscribePresence(handlePresenceUpdate);
  room.subscribeRoomState(handleRoomStateUpdate); // For potential future global state changes
  room.subscribePresenceUpdateRequests(handlePresenceUpdateRequest); // For resurrection, chunk requests
  room.onmessage = handleRoomMessages; // For broadcast events like bullets, explosions

  // Start the main game loop
  lastTimestamp = performance.now(); // Initialize timestamp
  requestAnimationFrame(gameLoop);
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // Camera zoom might need adjustment on resize if implemented
}

// --- Input Handling ---

function handleKeyDown(event) {
  keys[event.key.toLowerCase()] = true;
}

function handleKeyUp(event) {
  keys[event.key.toLowerCase()] = false;
}

function handleCanvasClick(event) {
    // Prevent resurrection attempts if the local player is dead
    if (localPlayer.dead) return;

    const worldCoords = screenToWorldCoords(event.clientX, event.clientY);
    const clickX = worldCoords.x;
    const clickY = worldCoords.y;

    console.log(`Canvas clicked at screen (${event.clientX}, ${event.clientY}), world (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);

    // Check if the click is near any *dead* player
    for (const clientId in players) {
        const potentialTarget = players[clientId];
        if (potentialTarget.dead) {
            // Distance from click to the center of the dead player's body
            const distClickToBody = Math.sqrt((clickX - potentialTarget.x) ** 2 + (clickY - potentialTarget.y) ** 2);
            console.log(`Checking dead player ${potentialTarget.username} at (${potentialTarget.x.toFixed(1)}, ${potentialTarget.y.toFixed(1)}), click distance: ${distClickToBody.toFixed(1)}`);

            if (distClickToBody <= CLICK_DETECTION_RADIUS) {
                // Click is near the body, now check if the *local player* (resurrector) is close enough
                const distPlayerToBody = Math.sqrt((localPlayer.x - potentialTarget.x) ** 2 + (localPlayer.y - potentialTarget.y) ** 2);
                console.log(`Local player distance to body: ${distPlayerToBody.toFixed(1)}`);

                if (distPlayerToBody <= RESURRECT_RANGE) {
                    console.log(`Attempting to resurrect player ${clientId} (${potentialTarget.username})`);
                    // Send a resurrection request to the dead player's client
                    room.requestPresenceUpdate(clientId, { type: 'requestResurrection' });
                    // Optional: Add local visual feedback (e.g., a particle effect)
                    // Could also break here if only one resurrection per click is desired
                } else {
                    console.log(`Click near dead player ${clientId}, but local player is too far away (${distPlayerToBody.toFixed(1)} > ${RESURRECT_RANGE}).`);
                    // Optional: Add feedback indicating player is too far
                }
                // Found a dead player near the click, stop checking others for this event
                return;
            }
        }
    }
    console.log("Click was not near any dead player body.");
}


// --- Networking ---

function handlePresenceUpdate(presence) {
  // Reset and repopulate the players object based on the latest full presence state
  players = {};
  let someoneChanged = false; // Flag to check if leaderboard update is needed

  for (const clientId in presence) {
    if (clientId !== room.clientId) { // Exclude self
        const pData = presence[clientId];
        const existingData = players[clientId]; // Get previous data if exists

        // Basic check for changes that affect leaderboard or require redraw
        if (!existingData ||
            existingData.x !== pData.x ||
            existingData.y !== pData.y ||
            existingData.score !== pData.score ||
            existingData.health !== pData.health ||
            existingData.dead !== pData.dead)
        {
            someoneChanged = true;
        }

        players[clientId] = {
            ...(room.peers[clientId] || { username: '...', avatarUrl: '' }), // Add username/avatar safely
            x: pData.x ?? 0,
            y: pData.y ?? 0,
            score: pData.score ?? 0,
            health: pData.health ?? MAX_HEALTH,
            maxHealth: pData.maxHealth ?? MAX_HEALTH,
            dead: pData.dead ?? false,
       };
    }
  }

    // Also check if peers list changed (player joined/left)
    if (Object.keys(players).length !== Object.keys(room.peers).length - 1) {
         someoneChanged = true;
         syncChunksWithPeers(); // Trigger chunk sync if peer list changed
    }


  if (someoneChanged) {
      updateLeaderboard();
  }
}

// Handle global room state changes (e.g., dynamic spawn point)
function handleRoomStateUpdate(roomState) {
    if (roomState.spawnX !== undefined && roomState.spawnY !== undefined) {
        // Could update a target spawn point if needed
        console.log("Room state updated spawn point:", roomState.spawnX, roomState.spawnY);
    }
}

// Handle direct requests from other clients
function handlePresenceUpdateRequest(updateRequest, fromClientId) {
    if (!updateRequest || !fromClientId) return; // Basic validation

    switch (updateRequest.type) {
        case 'requestChunkData':
            const chunkId = updateRequest.chunkId;
            if (chunkId && localChunks[chunkId] && !remoteChunks[chunkId]?.[room.clientId]) { // Only respond if we 'own' the chunk locally and aren't in conflict mode for it
                // Respond directly to the requesting client via a broadcast event targeted at them
                console.log(`Sending chunk ${chunkId} data to ${fromClientId}`);
                room.send({
                    type: 'chunkDataResponse',
                    chunkId: chunkId,
                    chunkData: localChunks[chunkId],
                    targetClientId: fromClientId // Target the specific client
                });
            }
            break;
        case 'requestResurrection':
            // Process only if the local player is currently dead
            if (localPlayer.dead) {
                console.log(`Received resurrection request from ${fromClientId}`);
                resurrectPlayer(fromClientId); // Perform resurrection locally
            } else {
                console.log(`Received resurrection request from ${fromClientId}, but not dead.`);
            }
            break;
        // Future: Handle damage requests here if PvP is added
        // case 'inflictDamage':
        //     if (!localPlayer.dead) {
        //         takeDamage(updateRequest.amount, fromClientId);
        //     }
        //     break;
        default:
            console.log(`Received unknown presence update request type: ${updateRequest.type} from ${fromClientId}`);
    }
}


// Handle broadcast messages from the room/other clients
function handleRoomMessages(event) {
    if (!event || !event.data) return; // Basic validation
    const data = event.data;
    const senderId = data.clientId; // ID of the client who sent the message

    switch (data.type) {
        case 'connected':
            console.log(`Client connected: ${data.clientId} (${data.username})`);
            syncChunksWithPeer(data.clientId); // Sync chunks with the newly connected peer
            updateLeaderboard(); // Update leaderboard when someone connects
            break;
        case 'disconnected':
            console.log(`Client disconnected: ${data.clientId} (${data.username})`);
            cleanUpDisconnectedPeerChunks(data.clientId); // Clean up chunk data associated with the disconnected peer
            delete players[data.clientId]; // Remove from local player list
            updateLeaderboard(); // Update leaderboard when someone disconnects
            break;
        case 'chunkDataResponse':
            // Only process if this message is targeted specifically at the local client
            if (data.targetClientId === room.clientId) {
                handleChunkDataResponse(data.chunkId, data.chunkData, senderId);
            }
            break;
        case 'bulletFired':
            // Add bullet to the local simulation if it wasn't fired by the local client
            if (senderId !== room.clientId) {
                bullets.push({ ...data.bulletData, remote: true }); // Mark as remote bullet
            }
            break;
        case 'explosion':
             // Trigger explosion locally if it wasn't caused by the local client
            if (senderId !== room.clientId) {
                createExplosion(data.x, data.y);
            }
            break;
        default:
           // Avoid logging every single message type like presence updates if they were sent via room.send
           // console.log("Received unhandled room message:", data);
           break;
    }
}


// --- Chunk Management ---

function getChunkId(x, y) {
  const chunkX = Math.floor(x / CHUNK_SIZE);
  const chunkY = Math.floor(y / CHUNK_SIZE);
  return `${chunkX}_${chunkY}`;
}

function getChunkCoordinates(chunkId) {
  const parts = chunkId.split('_');
  return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
}

// Determine which chunk IDs are currently visible on screen
function getVisibleChunkIds() {
  const visibleChunks = new Set();
  const halfWidth = canvas.width / 2 / camera.zoom;
  const halfHeight = canvas.height / 2 / camera.zoom;

  // Calculate world coordinates of screen edges, add buffer
  const minX = camera.x - halfWidth - CHUNK_SIZE;
  const maxX = camera.x + halfWidth + CHUNK_SIZE;
  const minY = camera.y - halfHeight - CHUNK_SIZE;
  const maxY = camera.y + halfHeight + CHUNK_SIZE;

  // Convert world coords to chunk coords
  const startChunkX = Math.floor(minX / CHUNK_SIZE);
  const endChunkX = Math.floor(maxX / CHUNK_SIZE);
  const startChunkY = Math.floor(minY / CHUNK_SIZE);
  const endChunkY = Math.floor(maxY / CHUNK_SIZE);

  // Add all chunks within the range to the set
  for (let cx = startChunkX; cx <= endChunkX; cx++) {
    for (let cy = startChunkY; cy <= endChunkY; cy++) {
      visibleChunks.add(`${cx}_${cy}`);
    }
  }
  return visibleChunks;
}

/**
 * Generates deterministic NPC and obstacle data for a given chunk.
 * Difficulty (NPC count, type, speed, firing rate) scales with distance from spawn (0,0).
 * Spawn chunks (defined by isSpawnChunk) have special fixed obstacles (walls/gates) and no NPCs.
 */
function generateChunkData(chunkX, chunkY) {
    const chunkId = `${chunkX}_${chunkY}`;
    const npcs = [];
    const obstacles = [];
    const isInSpawnArea = isSpawnChunk(chunkX, chunkY);
    // Distance from the absolute origin (0,0) chunk, used for difficulty scaling
    const distanceFactor = Math.sqrt(chunkX * chunkX + chunkY * chunkY);
    // Seeded noise generator specific to this chunk for deterministic randomness
    const seed = chunkX * 10000 + chunkY; // Simple seed based on coordinates
    const chunkNoise = createNoise2D(() => seed); // Seeded noise for this chunk

    // --- NPC Generation (Only outside spawn area) ---
    let numNpcs = 0;
    let npcBaseSpeed = 0.3;
    let baseShootInterval = 15000; // milliseconds
    let shooterProbability = 0; // 0 to 1
    let canShoot = false; // NPCs in this chunk allowed to shoot?

    if (!isInSpawnArea) {
        // Difficulty scaling logic based on distanceFactor
        if (distanceFactor < 2 + SPAWN_CHUNK_RADIUS) { // Adjacent chunks
            numNpcs = chunkNoise(0, 0) > 0.5 ? 1 : 0; // ~50% chance for 1 NPC
            npcBaseSpeed = 0.4;
            baseShootInterval = 18000 + chunkNoise(1,1) * 4000; // 18-22s, very rare shots
            shooterProbability = 0; // Dodgers only
            canShoot = false;
        } else if (distanceFactor < 5 + SPAWN_CHUNK_RADIUS) { // Close chunks
            numNpcs = Math.floor((chunkNoise(0, 0) + 1) / 2 * 1.5); // 0, 1, rarely 2
            npcBaseSpeed = 0.5 + distanceFactor * 0.05; // ~0.6 to 0.75
            baseShootInterval = 5000 + chunkNoise(1,1) * 3000; // 5-8s interval
            shooterProbability = 0.05; // Low chance of shooters
            canShoot = shooterProbability > 0;
        } else { // Further out chunks
            numNpcs = 1 + Math.floor((chunkNoise(0, 0) + 1) / 2 * (distanceFactor / 2));
            numNpcs = Math.min(numNpcs, 15); // Cap max NPCs
            npcBaseSpeed = 0.6 + distanceFactor * 0.08;
            npcBaseSpeed = Math.min(npcBaseSpeed, MAX_SPEED * 0.8); // Cap NPC speed below player max
            baseShootInterval = 2500 + chunkNoise(1,1) * 1500; // 2.5-4s interval
            shooterProbability = 0.2 + Math.min(0.4, distanceFactor * 0.015); // Scale shooter chance, cap lower
            canShoot = true;
        }

        // Create NPC objects
        for (let i = 0; i < numNpcs; i++) {
            const npcType = (shooterProbability > 0 && chunkNoise(i*2, i*2) < (shooterProbability*2-1)) ? 'shooter' : 'dodger'; // Use noise for type decision
            const speedMultiplier = Math.max(0.2, npcBaseSpeed + (chunkNoise(i * 5, i * 5) * 0.1)); // Vary speed slightly

            npcs.push({
                id: `npc_${chunkId}_${i}`,
                x: chunkX * CHUNK_SIZE + (chunkNoise(i * 10, 0) + 1) / 2 * CHUNK_SIZE, // Position with noise
                y: chunkY * CHUNK_SIZE + (chunkNoise(0, i * 10) + 1) / 2 * CHUNK_SIZE,
                vx: (chunkNoise(i * 0.1, 100) * 2 - 1) * speedMultiplier, // Initial velocity noise
                vy: (chunkNoise(100, i * 0.1) * 2 - 1) * speedMultiplier,
                type: npcType,
                lastShotTime: 0,
                shootInterval: baseShootInterval * (1 + (chunkNoise(i*3, i*3+1) * 0.4)) * (npcType === 'shooter' ? 0.9 : 1.1), // Add noise randomness + type adjust
                radius: 8,
                canShoot: canShoot
            });
        }
         console.log(`Chunk ${chunkId} (Dist: ${distanceFactor.toFixed(1)}): Generated ${numNpcs} NPCs (${npcs.filter(n => n.type==='shooter').length} shooters).`);
    }

    // --- Obstacle Generation ---
    if (isInSpawnArea) {
        // Generate fixed walls/gates only in the central spawn chunk (0,0) for simplicity
        if (chunkX === 0 && chunkY === 0) {
            console.log(`Chunk ${chunkId}: Generating Spawn Walls/Gates.`);
            const wallThickness = 20;
            const halfChunk = CHUNK_SIZE / 2;
            const gateWidth = 80;
            const segmentLength = (CHUNK_SIZE - gateWidth) / 2;

             // Correct calculation for wall segment positions (centered)
             // Wall segments positions are relative to the chunk center (0,0)
            const wallXOffset = halfChunk - segmentLength / 2; // Distance from center to center of segment
            const wallYOffset = halfChunk - segmentLength / 2;
            const wallCenterX = chunkX * CHUNK_SIZE;
            const wallCenterY = chunkY * CHUNK_SIZE;

            // North Wall (two segments) - Top edge
            obstacles.push({ id: `obs_spawn_n1`, x: wallCenterX - wallXOffset, y: wallCenterY - halfChunk + wallThickness / 2, width: segmentLength, height: wallThickness, type: 'wall' });
            obstacles.push({ id: `obs_spawn_n2`, x: wallCenterX + wallXOffset, y: wallCenterY - halfChunk + wallThickness / 2, width: segmentLength, height: wallThickness, type: 'wall' });
            // South Wall (two segments) - Bottom edge
            obstacles.push({ id: `obs_spawn_s1`, x: wallCenterX - wallXOffset, y: wallCenterY + halfChunk - wallThickness / 2, width: segmentLength, height: wallThickness, type: 'wall' });
            obstacles.push({ id: `obs_spawn_s2`, x: wallCenterX + wallXOffset, y: wallCenterY + halfChunk - wallThickness / 2, width: segmentLength, height: wallThickness, type: 'wall' });
            // West Wall (two segments) - Left edge
            obstacles.push({ id: `obs_spawn_w1`, x: wallCenterX - halfChunk + wallThickness / 2, y: wallCenterY - wallYOffset, width: wallThickness, height: segmentLength, type: 'wall' });
            obstacles.push({ id: `obs_spawn_w2`, x: wallCenterX - halfChunk + wallThickness / 2, y: wallCenterY + wallYOffset, width: wallThickness, height: segmentLength, type: 'wall' });
            // East Wall (two segments) - Right edge
            obstacles.push({ id: `obs_spawn_e1`, x: wallCenterX + halfChunk - wallThickness / 2, y: wallCenterY - wallYOffset, width: wallThickness, height: segmentLength, type: 'wall' });
            obstacles.push({ id: `obs_spawn_e2`, x: wallCenterX + halfChunk - wallThickness / 2, y: wallCenterY + wallYOffset, width: wallThickness, height: segmentLength, type: 'wall' });
        } else {
             console.log(`Chunk ${chunkId}: In spawn area (not central), no obstacles/NPCs.`);
        }
    } else {
        // Generate random obstacles (circular) outside the spawn area
        let numObstacles = Math.floor((chunkNoise(100, 100) + 1) / 2 * (2 + distanceFactor * 0.4) + 1);
        numObstacles = Math.min(numObstacles, 10); // Cap obstacles per chunk

        for (let i = 0; i < numObstacles; i++) {
            const normalizedNoiseX = (chunkNoise(200 + i, 200 + i) + 1) / 2;
            const normalizedNoiseY = (chunkNoise(300 + i, 300 + i) + 1) / 2;
            const normalizedNoiseRadius = (chunkNoise(400 + i, 400 + i) + 1) / 2;

            obstacles.push({
                id: `obs_${chunkId}_${i}`,
                // Position within chunk, avoiding edges slightly
                x: chunkX * CHUNK_SIZE + normalizedNoiseX * CHUNK_SIZE * 0.8 + CHUNK_SIZE * 0.1,
                y: chunkY * CHUNK_SIZE + normalizedNoiseY * CHUNK_SIZE * 0.8 + CHUNK_SIZE * 0.1,
                // Radius scales slightly with distance, ensuring minimum size
                radius: normalizedNoiseRadius * 10 + 8 + Math.min(12, (distanceFactor * 1.0)), // Ensure Math.min has two valid number arguments
                type: 'random' // Mark as randomly generated obstacle
            });
        }
        // console.log(`Chunk ${chunkId}: Generated ${numObstacles} random obstacles.`);
    }

    return { npcs, obstacles };
}


// Ensure chunk data exists locally, generating if necessary
function ensureChunkExists(chunkId) {
  if (!localChunks[chunkId]) {
    const coords = getChunkCoordinates(chunkId);
    console.log(`Generating chunk data for ${chunkId} (${coords.x}, ${coords.y})`);
    localChunks[chunkId] = generateChunkData(coords.x, coords.y);
    saveChunksToLocalStorage(); // Save after generation
    checkForConflicts(chunkId); // Check if this new chunk conflicts with remote data
  }
  // Return the data whether it was just generated or already existed
  return localChunks[chunkId];
}

// Load chunk data from browser's local storage
function loadChunksFromLocalStorage() {
  const storedChunks = localStorage.getItem('infiniteBulletHellChunks');
  if (storedChunks) {
    try {
      localChunks = JSON.parse(storedChunks);
      console.log(`Loaded ${Object.keys(localChunks).length} chunks from localStorage.`);
      // After loading, ensure sync with any already connected peers
      syncChunksWithPeers();
    } catch (e) {
      console.error("Error parsing chunks from localStorage:", e);
      localChunks = {};
      localStorage.removeItem('infiniteBulletHellChunks'); // Clear corrupted data
    }
  }
}

// Save current local chunk data to browser's local storage
function saveChunksToLocalStorage() {
  try {
    // Basic check for excessive size (optional, browser limits vary)
    // if (JSON.stringify(localChunks).length > 4 * 1024 * 1024) { // ~4MB limit check
    //     console.warn("Chunk data size approaching localStorage limit. Consider pruning.");
    // }
    localStorage.setItem('infiniteBulletHellChunks', JSON.stringify(localChunks));
  } catch (e) {
    console.error("Error saving chunks to localStorage (Quota Exceeded?):", e);
    // Implement pruning strategy here if needed (e.g., remove distant/old chunks)
  }
}

// --- Chunk Synchronization & Conflict Resolution ---

// Initiate requests for chunk data from all connected peers
function syncChunksWithPeers() {
    console.log("Initiating chunk sync with all peers...");
    for (const peerId in room.peers) {
        if (peerId !== room.clientId) {
            syncChunksWithPeer(peerId);
        }
    }
}

// Request visible chunk data from a specific peer
function syncChunksWithPeer(peerId) {
    console.log(`Requesting visible chunk data from peer: ${peerId}`);
    const visibleChunks = getVisibleChunkIds();
    visibleChunks.forEach(chunkId => {
        // Request data if we don't have it locally OR if we know there's remote data (potential conflict)
        if (!localChunks[chunkId] || remoteChunks[chunkId]) {
            // console.log(`Requesting chunk ${chunkId} from ${peerId}`);
            room.requestPresenceUpdate(peerId, { type: 'requestChunkData', chunkId });
        }
    });
}

// Handle received chunk data from another peer
function handleChunkDataResponse(chunkId, chunkData, fromClientId) {
     if (!chunkId || !chunkData || !fromClientId) return; // Validation
    // console.log(`Received chunk ${chunkId} data from ${fromClientId}`);

    // Ensure the remote chunk storage exists for this ID
    if (!remoteChunks[chunkId]) {
        remoteChunks[chunkId] = {};
    }
    // Store the received data, associating it with the sender
    // Use deep copy to avoid reference issues if chunkData is modified later
    remoteChunks[chunkId][fromClientId] = JSON.parse(JSON.stringify(chunkData));

    // Check for conflicts now that new remote data has arrived
    checkForConflicts(chunkId);
}

// Check if multiple clients (including local) have differing data for the same chunk
function checkForConflicts(chunkId) {
    const involvedClientIds = new Set();

    // Check local data
    if (localChunks[chunkId]) {
        involvedClientIds.add(room.clientId);
    }

    // Check remote data from currently connected peers
    if (remoteChunks[chunkId]) {
        Object.keys(remoteChunks[chunkId]).forEach(clientId => {
            if (room.peers[clientId]) { // Only consider connected peers
                involvedClientIds.add(clientId);
            } else {
                 // Clean up data from peers who disconnected while we held their chunk data
                 delete remoteChunks[chunkId][clientId];
                 if (Object.keys(remoteChunks[chunkId]).length === 0) {
                     delete remoteChunks[chunkId];
                 }
            }
        });
    }

    // --- Conflict Resolution Logic ---
    if (involvedClientIds.size > 1) {
        // Conflict: Multiple clients have data for this chunk.
        console.warn(`Conflict detected for chunk ${chunkId}. Participants: ${Array.from(involvedClientIds).join(', ')}. Resolving...`);
        // Deterministic resolution: Choose the client with the lexicographically smallest ID.
        const winnerClientId = Array.from(involvedClientIds).sort()[0];
        resolveChunkConflict(chunkId, winnerClientId);

    } else if (involvedClientIds.size === 1) {
        // No conflict / Resolved: Only one client claims ownership.
        const soleOwnerId = Array.from(involvedClientIds)[0];

        if (soleOwnerId === room.clientId) {
            // We are the sole owner. Ensure no lingering remote data entries exist.
            if (remoteChunks[chunkId]) {
                // console.log(`Conflict resolved for ${chunkId}: Local client (${room.clientId}) is sole owner. Clearing remote entries.`);
                delete remoteChunks[chunkId];
            }
        } else {
            // Another client is the sole owner. Make sure our local data matches theirs.
            const ownerData = remoteChunks[chunkId]?.[soleOwnerId];
            if (ownerData) {
                // We have the owner's data. Check if local data needs updating.
                 // Use stringify for simple comparison; more robust might involve hashing.
                if (!localChunks[chunkId] || JSON.stringify(localChunks[chunkId]) !== JSON.stringify(ownerData)) {
                    console.log(`Adopting chunk ${chunkId} data from sole owner ${soleOwnerId}.`);
                    localChunks[chunkId] = JSON.parse(JSON.stringify(ownerData)); // Deep copy
                    saveChunksToLocalStorage();
                }
                // Clean up remote data entry now that we've adopted or confirmed match.
                 delete remoteChunks[chunkId];

            } else {
                // We know who the owner is, but we don't have their data yet. Request it.
                console.log(`Missing chunk ${chunkId} data from sole owner ${soleOwnerId}. Requesting...`);
                requestChunkDataFromPeer(chunkId, soleOwnerId);
                 // Keep the remoteChunks entry for now, it will be cleaned when data arrives or owner disconnects.
            }
        }
     } else {
          // Size is 0: No one claims this chunk (locally or remotely). Clean up remote entry if it exists.
          if (remoteChunks[chunkId]) {
             delete remoteChunks[chunkId];
          }
     }
}


// Force resolution of a conflict by adopting the winner's data
function resolveChunkConflict(chunkId, winnerClientId) {
    console.log(`Resolving conflict for chunk ${chunkId}, winner: ${winnerClientId}`);

    let winningChunkData = null;

    // Get the winning data source
    if (winnerClientId === room.clientId) {
        // We won. Ensure our local data exists (should normally be true).
        if (!localChunks[chunkId]) {
            console.warn(`Winner (${room.clientId}) for chunk ${chunkId}, but local data missing! Generating.`);
            ensureChunkExists(chunkId); // Generate if somehow missing
        }
        winningChunkData = localChunks[chunkId];
    } else if (remoteChunks[chunkId] && remoteChunks[chunkId][winnerClientId]) {
        // Winner is remote, and we have their data.
        winningChunkData = remoteChunks[chunkId][winnerClientId];
    } else {
        // Winner is remote, but we *don't* have their data. Request it.
        console.warn(`Winner ${winnerClientId}'s data for chunk ${chunkId} not found locally. Requesting...`);
        if (room.peers[winnerClientId]) { // Check if winner is still connected
            requestChunkDataFromPeer(chunkId, winnerClientId);
        } else {
            console.warn(`Winner ${winnerClientId} disconnected before data could be retrieved. Re-evaluating conflict for ${chunkId}.`);
            // Remove the disconnected winner from the remote chunk data and re-run check
            if(remoteChunks[chunkId]) {
                 delete remoteChunks[chunkId][winnerClientId];
                  if (Object.keys(remoteChunks[chunkId]).length === 0) {
                     delete remoteChunks[chunkId];
                 }
            }
            checkForConflicts(chunkId); // Re-check immediately
        }
        // Cannot fully resolve locally until data arrives or winner disconnects.
        return;
    }

    // Ensure winning data is valid
     if (!winningChunkData) {
         console.error(`Conflict resolution failed for ${chunkId}: Winning data is null/undefined.`);
         // Potentially regenerate or clear the chunk? For now, just log error.
         return;
     }


    // Update local data to match the winner's data (if necessary)
    if (!localChunks[chunkId] || JSON.stringify(localChunks[chunkId]) !== JSON.stringify(winningChunkData)) {
        console.log(`Updating local chunk ${chunkId} with winner's (${winnerClientId}) data.`);
        localChunks[chunkId] = JSON.parse(JSON.stringify(winningChunkData)); // Deep copy
        saveChunksToLocalStorage();
    }

    // Clean up all remote data entries for this chunk now that the conflict is resolved locally.
    delete remoteChunks[chunkId];

    console.log(`Conflict for chunk ${chunkId} resolved. Using data from ${winnerClientId}.`);
}


// Clean up chunk data associated with a peer that has disconnected
function cleanUpDisconnectedPeerChunks(disconnectedClientId) {
    const affectedChunks = new Set();
    // Remove the disconnected peer's data from all remote chunk entries
    for (const chunkId in remoteChunks) {
        if (remoteChunks[chunkId][disconnectedClientId]) {
            delete remoteChunks[chunkId][disconnectedClientId];
            affectedChunks.add(chunkId);
            // If no other remote clients have data for this chunk, remove the chunk entry itself
            if (Object.keys(remoteChunks[chunkId]).length === 0) {
                delete remoteChunks[chunkId];
            }
        }
    }

    // Re-evaluate conflict status for chunks potentially affected by the disconnect
    affectedChunks.forEach(chunkId => {
        console.log(`Re-checking conflict status for chunk ${chunkId} after peer ${disconnectedClientId} disconnected.`);
        checkForConflicts(chunkId);
    });
}

// Helper to specifically request chunk data from one peer
function requestChunkDataFromPeer(chunkId, peerId) {
    if (!peerId || !chunkId || !room.peers[peerId]) {
        console.warn(`Cannot request chunk ${chunkId} from invalid or disconnected peer ${peerId}`);
        return;
    }
    console.log(`Requesting chunk ${chunkId} specifically from peer ${peerId}`);
    room.requestPresenceUpdate(peerId, { type: 'requestChunkData', chunkId });
}


// --- Game Logic Updates ---

function updatePlayer(deltaTime) {
    if (localPlayer.dead) return; // No updates if dead

    const now = Date.now();

    // --- Health Regeneration ---
    if (localPlayer.health < localPlayer.maxHealth) {
        localPlayer.health += HEALTH_REGEN_RATE * deltaTime;
        localPlayer.health = Math.min(localPlayer.health, localPlayer.maxHealth); // Cap at max health
    }

    // --- Movement Input ---
    let moveX = 0;
    let moveY = 0;
    if (keys['w'] || keys['arrowup']) moveY -= 1;
    if (keys['s'] || keys['arrowdown']) moveY += 1;
    if (keys['a'] || keys['arrowleft']) moveX -= 1;
    if (keys['d'] || keys['arrowright']) moveX += 1;

    // Normalize movement vector and apply speed
    const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
    if (magnitude > 0) {
        localPlayer.vx = (moveX / magnitude) * MAX_SPEED;
        localPlayer.vy = (moveY / magnitude) * MAX_SPEED;
    } else {
        // Apply deceleration if no input
        localPlayer.vx *= 0.9;
        localPlayer.vy *= 0.9;
        // Stop movement below a threshold
        if (Math.abs(localPlayer.vx) < 0.1) localPlayer.vx = 0;
        if (Math.abs(localPlayer.vy) < 0.1) localPlayer.vy = 0;
    }

    // Proposed next position
    let nextX = localPlayer.x + localPlayer.vx;
    let nextY = localPlayer.y + localPlayer.vy;

    // --- Collision Detection & Response ---
     let collisionDetected = false;
     const nearbyChunks = getNearbyChunkIds(localPlayer.x, localPlayer.y, 1); // Check current and adjacent chunks

     nearbyChunks.forEach(chunkId => {
         const chunk = localChunks[chunkId]; // Use definitive local data
         if (chunk && chunk.obstacles) {
             chunk.obstacles.forEach(obstacle => {
                 if (!obstacle) return;

                 if (obstacle.type === 'wall') {
                     // AABB Collision for Walls
                     const playerLeft = nextX - PLAYER_RADIUS;
                     const playerRight = nextX + PLAYER_RADIUS;
                     const playerTop = nextY - PLAYER_RADIUS;
                     const playerBottom = nextY + PLAYER_RADIUS;

                     const wallLeft = obstacle.x - obstacle.width / 2;
                     const wallRight = obstacle.x + obstacle.width / 2;
                     const wallTop = obstacle.y - obstacle.height / 2;
                     const wallBottom = obstacle.y + obstacle.height / 2;

                     if (playerRight > wallLeft && playerLeft < wallRight && playerBottom > wallTop && playerTop < wallBottom) {
                          collisionDetected = true;
                         // Basic push-back: Find minimum overlap axis and adjust next position
                         const overlapX = Math.min(playerRight - wallLeft, wallRight - playerLeft);
                         const overlapY = Math.min(playerBottom - wallTop, wallBottom - playerTop);

                         if (overlapX < overlapY) { // Horizontal collision is primary
                             if (localPlayer.x < obstacle.x) nextX = wallLeft - PLAYER_RADIUS - 0.1; // Push left
                             else nextX = wallRight + PLAYER_RADIUS + 0.1; // Push right
                             localPlayer.vx = 0; // Stop horizontal movement
                         } else { // Vertical collision is primary
                             if (localPlayer.y < obstacle.y) nextY = wallTop - PLAYER_RADIUS - 0.1; // Push up
                             else nextY = wallBottom + PLAYER_RADIUS + 0.1; // Push down
                             localPlayer.vy = 0; // Stop vertical movement
                         }
                     }
                 } else if (obstacle.radius) {
                     // Circle-Circle Collision
                     const dist = Math.sqrt((nextX - obstacle.x) ** 2 + (nextY - obstacle.y) ** 2);
                     const minRadius = PLAYER_RADIUS + obstacle.radius;

                     if (dist < minRadius) {
                          collisionDetected = true;
                         // Push-back based on collision angle
                         const overlap = minRadius - dist;
                         const angle = Math.atan2(nextY - obstacle.y, nextX - obstacle.x);

                         // Adjust next position directly away from obstacle center
                         nextX += Math.cos(angle) * overlap;
                         nextY += Math.sin(angle) * overlap;

                         // Dampen velocity to prevent sticking (optional)
                         // localPlayer.vx *= 0.8;
                         // localPlayer.vy *= 0.8;
                          // More simply, prevent movement *into* the obstacle
                         // This requires resolving collisions iteratively or using projection,
                         // For now, simple pushback is used. Stop velocity if pushed back significantly.
                          const pushbackDist = Math.sqrt( (Math.cos(angle) * overlap)**2 + (Math.sin(angle) * overlap)**2 );
                         if (pushbackDist > 0.5) { // If pushed significantly
                              localPlayer.vx = 0;
                              localPlayer.vy = 0;
                         }

                     }
                 }
             });
         }
     });

     // Apply final position after collision checks
     localPlayer.x = nextX;
     localPlayer.y = nextY;


    // --- Score Calculation ---
    const playerChunkCoords = getChunkCoordinates(getChunkId(localPlayer.x, localPlayer.y));
    const playerChunkId = getChunkId(localPlayer.x, localPlayer.y);
    const inSpawn = isSpawnChunk(playerChunkCoords.x, playerChunkCoords.y);

    let scoreRateMultiplier = 0; // Default to 0 (no score increase)

    if (!inSpawn) {
        // Outside spawn area, check if near spawn and if chunk has enemies
        const distanceFactor = Math.sqrt(playerChunkCoords.x ** 2 + playerChunkCoords.y ** 2);
        const nearSpawnThreshold = 2 + SPAWN_CHUNK_RADIUS; // Matches NPC generation boundary
        const chunk = localChunks[playerChunkId];
        const noEnemiesInChunk = chunk && chunk.npcs && chunk.npcs.length === 0;

        if (distanceFactor < nearSpawnThreshold && noEnemiesInChunk) {
             // Near spawn AND no enemies: Reduced score rate
            scoreRateMultiplier = 0.001; // 1/1000th
        } else {
            // Far from spawn OR near spawn with enemies: Normal score rate
            scoreRateMultiplier = 1.0;
        }
    }
    // else: Inside spawn area, multiplier remains 0.

    localPlayer.timeOutsideSpawnMs += deltaTime * 1000 * scoreRateMultiplier;
    localPlayer.score = Math.floor(localPlayer.timeOutsideSpawnMs / 100); // 1 point per 100ms at normal rate

    // --- UI Updates ---
    scoreElement.textContent = `Score: ${localPlayer.score}`;
    updateHealthUI();

    // --- Presence Update ---
    if (now - localPlayer.lastUpdateTime > 50) { // Send updates ~20 times/sec
        room.updatePresence({
            x: localPlayer.x,
            y: localPlayer.y,
            score: localPlayer.score,
            health: localPlayer.health,
            maxHealth: localPlayer.maxHealth,
            dead: localPlayer.dead,
            // Optionally send vx, vy if needed for prediction/smoothing on other clients
        });
        localPlayer.lastUpdateTime = now;
    }

    // --- Camera Update ---
    // Smooth camera follow (optional)
     // camera.x += (localPlayer.x - camera.x) * 0.1;
     // camera.y += (localPlayer.y - camera.y) * 0.1;
     // Direct follow:
    camera.x = localPlayer.x;
    camera.y = localPlayer.y;
}


// Get chunk IDs for a given center point and radius (e.g., for collision checks)
function getNearbyChunkIds(x, y, radius = 1) {
    const centerChunkX = Math.floor(x / CHUNK_SIZE);
    const centerChunkY = Math.floor(y / CHUNK_SIZE);
    const nearbyIds = new Set();
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            nearbyIds.add(`${centerChunkX + dx}_${centerChunkY + dy}`);
        }
    }
    return nearbyIds;
}

function updateNPCs(deltaTime) {
    const visibleChunks = getVisibleChunkIds();
    const now = Date.now();

    visibleChunks.forEach(chunkId => {
        // Process NPCs only for chunks definitively owned locally (no conflict or resolved to local)
        if (localChunks[chunkId] && !remoteChunks[chunkId]) {
            const chunk = localChunks[chunkId];
            if (!chunk.npcs) chunk.npcs = []; // Ensure array exists

            chunk.npcs.forEach(npc => {
                 if(!npc || !npc.radius) return; // Skip if NPC data is invalid

                // --- NPC Movement ---
                 const prevX = npc.x;
                 const prevY = npc.y;
                npc.x += npc.vx;
                npc.y += npc.vy;

                // --- Collision with Obstacles within the same chunk ---
                 let collidedWithObstacle = false;
                 if (chunk.obstacles) {
                     chunk.obstacles.forEach(obstacle => {
                         if (!obstacle) return;
                           const checkX = npc.x; // Check collision at new position
                           const checkY = npc.y;

                         if (obstacle.type === 'wall') {
                             // AABB collision (NPC is circle, Wall is rect) - Simplified check against wall edges
                              const npcLeft = checkX - npc.radius;
                              const npcRight = checkX + npc.radius;
                              const npcTop = checkY - npc.radius;
                              const npcBottom = checkY + npc.radius;

                              const wallLeft = obstacle.x - obstacle.width / 2;
                              const wallRight = obstacle.x + obstacle.width / 2;
                              const wallTop = obstacle.y - obstacle.height / 2;
                              const wallBottom = obstacle.y + obstacle.height / 2;

                             if (npcRight > wallLeft && npcLeft < wallRight && npcBottom > wallTop && npcTop < wallBottom) {
                                  collidedWithObstacle = true;
                                  // Simple revert & deflect strategy
                                  npc.x = prevX; // Revert position slightly
                                  npc.y = prevY;
                                   // Deflect based on which side hit - very basic
                                  const overlapX = Math.min(npcRight - wallLeft, wallRight - npcLeft);
                                  const overlapY = Math.min(npcBottom - wallTop, wallBottom - npcTop);
                                  if (overlapX < overlapY) npc.vx *= -1 * (0.8 + Math.random()*0.4); // Bounce horizontal + randomness
                                  else npc.vy *= -1 * (0.8 + Math.random()*0.4); // Bounce vertical + randomness
                             }

                         } else if (obstacle.radius) {
                             // Circle-Circle Collision
                             const dist = Math.sqrt((checkX - obstacle.x) ** 2 + (checkY - obstacle.y) ** 2);
                             const minRadius = npc.radius + obstacle.radius;
                             if (dist < minRadius) {
                                 collidedWithObstacle = true;
                                  // Revert position & Deflect away from obstacle center
                                 npc.x = prevX;
                                 npc.y = prevY;
                                 const angle = Math.atan2(checkY - obstacle.y, checkX - obstacle.x);
                                 const speed = Math.sqrt(npc.vx*npc.vx + npc.vy*npc.vy);
                                  // Reverse direction slightly away from obstacle
                                 npc.vx = Math.cos(angle) * speed * (0.8 + Math.random()*0.4); // Deflect + randomness
                                 npc.vy = Math.sin(angle) * speed * (0.8 + Math.random()*0.4);
                             }
                         }
                     });
                 }


                // --- Collision with Chunk Boundaries ---
                const chunkCoords = getChunkCoordinates(chunkId);
                const minX = chunkCoords.x * CHUNK_SIZE;
                const maxX = minX + CHUNK_SIZE;
                const minY = chunkCoords.y * CHUNK_SIZE;
                const maxY = minY + CHUNK_SIZE;

                let bounced = false;
                if (npc.x < minX + npc.radius) { npc.x = minX + npc.radius; npc.vx *= -1; bounced = true; }
                if (npc.x > maxX - npc.radius) { npc.x = maxX - npc.radius; npc.vx *= -1; bounced = true; }
                if (npc.y < minY + npc.radius) { npc.y = minY + npc.radius; npc.vy *= -1; bounced = true; }
                if (npc.y > maxY - npc.radius) { npc.y = maxY - npc.radius; npc.vy *= -1; bounced = true; }

                 // Apply random turn on boundary bounce to prevent loops
                 if (bounced && !collidedWithObstacle) { // Only apply random turn if not also hitting obstacle
                     const angleChange = (Math.random() - 0.5) * 0.5; // +/- ~14 degrees
                     const currentAngle = Math.atan2(npc.vy, npc.vx);
                     const newAngle = currentAngle + angleChange;
                     const speed = Math.sqrt(npc.vx * npc.vx + npc.vy * npc.vy);
                     npc.vx = Math.cos(newAngle) * speed;
                     npc.vy = Math.sin(newAngle) * speed;
                 }


                // --- Shooting Logic ---
                 // Use the canShoot flag determined during generation
                const canShootNow = (npc.canShoot ?? false) && (now - npc.lastShotTime > npc.shootInterval);

                if (canShootNow) {
                    // Target prioritization: Find closest non-dead player within range
                    let closestPlayer = null;
                    let minDistSq = (CHUNK_SIZE * 0.8) ** 2; // Max shooting range (squared)

                    // Check local player
                    if (!localPlayer.dead) {
                        const dx = localPlayer.x - npc.x;
                        const dy = localPlayer.y - npc.y;
                        const distSq = dx * dx + dy * dy;
                        if (distSq < minDistSq) {
                            minDistSq = distSq;
                            closestPlayer = localPlayer;
                        }
                    }
                    // Check other players
                    for(const pId in players) {
                         const player = players[pId];
                         if (!player.dead) {
                              const dx = player.x - npc.x;
                              const dy = player.y - npc.y;
                              const distSq = dx * dx + dy * dy;
                             if (distSq < minDistSq) {
                                 minDistSq = distSq;
                                 closestPlayer = player;
                             }
                         }
                    }


                    if (closestPlayer) {
                         const dx = closestPlayer.x - npc.x;
                         const dy = closestPlayer.y - npc.y;
                         const dist = Math.sqrt(minDistSq); // Actual distance

                         // Calculate bullet speed based on where NPC spawned
                         const spawnDistanceFactor = Math.sqrt(chunkCoords.x**2 + chunkCoords.y**2);
                         let bulletSpeed = 2 + Math.min(3, spawnDistanceFactor * 0.2); // Base 2, scales up to 5
                         if (npc.type === 'dodger') bulletSpeed *= 0.8; // Dodgers shoot slower

                        // Fire bullet
                        const bulletVx = (dx / dist) * bulletSpeed;
                        const bulletVy = (dy / dist) * bulletSpeed;
                        const bulletType = npc.type === 'shooter' ? 'shooter' : 'dodger';
                        const bulletData = {
                            x: npc.x,
                            y: npc.y,
                            vx: bulletVx,
                            vy: bulletVy,
                            ownerChunkX: chunkCoords.x, // Store origin chunk coords
                            ownerChunkY: chunkCoords.y,
                            ownerId: npc.id, // Identify NPC owner
                            radius: BULLET_RADIUS,
                            type: bulletType
                        };

                        bullets.push(bulletData); // Add locally
                        room.send({ type: 'bulletFired', bulletData }); // Broadcast to others

                        npc.lastShotTime = now;
                        // Randomize next shot interval slightly
                        npc.shootInterval *= (1 + (Math.random() * 0.2 - 0.1)); // +/- 10% variation
                        npc.shootInterval = Math.max(1000, npc.shootInterval); // Ensure minimum interval
                    }
                }
            });
        }
    });
}


function updateBullets(deltaTime) {
    // Determine the set of chunks where bullets might exist or interact
    const visibleChunks = getVisibleChunkIds();
    const activeChunkBounds = new Set(visibleChunks);
    // Include adjacent chunks to allow bullets to travel across boundaries smoothly
     visibleChunks.forEach(id => {
        const coords = getChunkCoordinates(id);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                activeChunkBounds.add(`${coords.x + dx}_${coords.y + dy}`);
            }
        }
    });

    bullets = bullets.filter(bullet => {
        if (!bullet || !bullet.radius) return false; // Remove invalid bullets

        // --- Bullet Movement ---
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        // --- Collision with Local Player ---
        if (!localPlayer.dead) {
            const distSq = (localPlayer.x - bullet.x) ** 2 + (localPlayer.y - bullet.y) ** 2;
            const minDistSq = (PLAYER_RADIUS + bullet.radius) ** 2;
            if (distSq < minDistSq) {
                const damage = bullet.type === 'dodger' ? DODGER_BULLET_DAMAGE : BULLET_DAMAGE;
                takeDamage(damage, bullet.ownerId); // Pass damage and owner (if needed for kill credit later)

                // Trigger explosion locally and broadcast for dodger bullets
                if (bullet.type === 'dodger') {
                    createExplosion(bullet.x, bullet.y);
                    room.send({ type: 'explosion', x: bullet.x, y: bullet.y });
                }
                return false; // Remove bullet on hit
            }
        }

        // --- Collision with Obstacles ---
        const bulletChunkId = getChunkId(bullet.x, bullet.y);
        const chunk = localChunks[bulletChunkId]; // Use definitive local data for collision
         if (chunk && chunk.obstacles) {
             for (const obstacle of chunk.obstacles) {
                 if (!obstacle) continue;

                 let collision = false;
                 if (obstacle.type === 'wall') {
                      // AABB collision check (bullet is circle, wall is rect)
                     const closestX = Math.max(obstacle.x - obstacle.width / 2, Math.min(bullet.x, obstacle.x + obstacle.width / 2));
                     const closestY = Math.max(obstacle.y - obstacle.height / 2, Math.min(bullet.y, obstacle.y + obstacle.height / 2));
                     const distSq = (bullet.x - closestX)**2 + (bullet.y - closestY)**2;
                     if (distSq < bullet.radius**2) {
                         collision = true;
                     }
                 } else if (obstacle.radius) {
                      // Circle-Circle collision check
                      const distSq = (bullet.x - obstacle.x)**2 + (bullet.y - obstacle.y)**2;
                      const minDistSq = (bullet.radius + obstacle.radius)**2;
                      if (distSq < minDistSq) {
                          collision = true;
                      }
                 }


                 if (collision) {
                     // Trigger explosion for dodger bullets on obstacle hit
                     if (bullet.type === 'dodger') {
                         createExplosion(bullet.x, bullet.y);
                         room.send({ type: 'explosion', x: bullet.x, y: bullet.y });
                     }
                     return false; // Remove bullet on obstacle collision
                 }
             }
         }

        // --- Bullet Despawning ---
        // Check if bullet is outside the active boundary + a buffer
        if (!activeChunkBounds.has(bulletChunkId)) {
            // Allow bullets to travel ~2 chunks beyond visible before despawning
            const currentCoords = getChunkCoordinates(bulletChunkId);
            const dx = Math.abs(currentCoords.x - bullet.ownerChunkX);
            const dy = Math.abs(currentCoords.y - bullet.ownerChunkY);
            if (dx > 2 || dy > 2) {
               // console.log(`Despawning bullet ${bullet.ownerId} far from origin.`);
               return false; // Remove bullet far from its origin
            }
        }

        return true; // Keep bullet if no collision or despawn condition met
    });
}


function takeDamage(amount, sourceId = null) {
    if (localPlayer.dead) return; // Can't take damage if already dead

    localPlayer.health -= amount;
    console.log(`Player took ${amount} damage${sourceId ? ` from ${sourceId}` : ''}, health: ${localPlayer.health.toFixed(0)}`);

    // Update health UI immediately
    updateHealthUI();

    if (localPlayer.health <= 0) {
        localPlayer.health = 0;
        die(); // Handle death logic
    }
    // No immediate presence update here, relies on the periodic update in updatePlayer
    // Send event for visual feedback (e.g. screen shake, damage vignette)?
}

function die() {
    if (localPlayer.dead) return; // Prevent dying multiple times

    console.log("Player died!");
    localPlayer.dead = true;
    localPlayer.health = 0;
    localPlayer.vx = 0; // Stop movement
    localPlayer.vy = 0;

    // Update presence immediately to notify others of death state and final position
    room.updatePresence({
        dead: true,
        health: 0,
        x: localPlayer.x,
        y: localPlayer.y,
        vx: 0,
        vy: 0,
        // Score is usually kept, but could be reset here if desired
    });

    // Update UI elements
    updateHealthUI(); // Show 0 health
    updateLeaderboard(); // Show player as dead on leaderboard
    showRespawnPrompt(); // Show the respawn UI
}


function createExplosion(x, y) {
    // Add explosion effect data to the list
    explosions.push({ x, y, startTime: Date.now(), maxRadius: EXPLOSION_RADIUS });
    // Optional: Add screen shake or other local effects
}

function updateExplosions(deltaTime) {
    const now = Date.now();
    // Filter out explosions that have exceeded their duration
    explosions = explosions.filter(explosion => {
        const age = (now - explosion.startTime) / 1000; // Age in seconds
        return age < EXPLOSION_DURATION;
    });
}


// --- Rendering ---

function draw() {
    // Clear canvas with background color
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // --- Camera Transform ---
    ctx.save();
    // Apply camera zoom first, then translate
    ctx.translate(canvas.width / 2, canvas.height / 2); // Move origin to center
    ctx.scale(camera.zoom, camera.zoom); // Apply zoom
    ctx.translate(-camera.x, -camera.y); // Translate to camera world position

    // --- Draw World Elements (Chunks, Obstacles, NPCs) ---
    drawChunkGrid(); // Draw grid lines first

    const visibleChunks = getVisibleChunkIds();
    visibleChunks.forEach(chunkId => {
        const chunk = localChunks[chunkId]; // Use definitive local data
        const coords = getChunkCoordinates(chunkId);
        const chunkWorldX = coords.x * CHUNK_SIZE;
        const chunkWorldY = coords.y * CHUNK_SIZE;

        if (chunk) {
             // Draw Obstacles
             if (chunk.obstacles) {
                chunk.obstacles.forEach(obstacle => {
                    if (!obstacle) return;
                    ctx.save(); // Save context for potential individual styling
                     ctx.translate(obstacle.x, obstacle.y); // Translate to obstacle center for easier drawing/rotation if needed

                    if (obstacle.type === 'wall') {
                        ctx.fillStyle = '#666'; // Wall color
                        ctx.fillRect(-obstacle.width / 2, -obstacle.height / 2, obstacle.width, obstacle.height);
                    } else if (obstacle.radius && obstacle.radius > 0) {
                        ctx.fillStyle = '#555'; // Random obstacle color
                        ctx.beginPath();
                        ctx.arc(0, 0, obstacle.radius, 0, Math.PI * 2); // Draw centered at origin
                        ctx.fill();
                    } else if (obstacle.radius <= 0) {
                         console.warn("Skipping drawing obstacle with invalid radius:", obstacle);
                          ctx.fillStyle = 'magenta'; // Error marker
                          ctx.fillRect(-5, -5, 10, 10);
                    }
                     ctx.restore(); // Restore context
                });
            }

             // Draw NPCs
            if (chunk.npcs) {
                chunk.npcs.forEach(npc => {
                     if (!npc || !npc.radius || npc.radius <= 0) {
                         console.warn("Skipping drawing NPC with invalid radius:", npc);
                         return;
                     }
                    ctx.fillStyle = npc.type === 'shooter' ? '#f55' : '#f90'; // Red for shooters, orange for dodgers
                    ctx.beginPath();
                    ctx.arc(npc.x, npc.y, npc.radius, 0, Math.PI * 2);
                    ctx.fill();
                });
            }

        } else {
            // Optionally indicate chunks that are loading/not yet generated
            // ctx.strokeStyle = '#444';
            // ctx.strokeRect(chunkWorldX, chunkWorldY, CHUNK_SIZE, CHUNK_SIZE);
            // ctx.fillStyle = '#fff';
            // ctx.font = '10px sans-serif';
            // ctx.fillText("Loading...", chunkWorldX + 10, chunkWorldY + 20);
        }
    });

     // --- Draw Bullets ---
    bullets.forEach(bullet => {
         if (!bullet || !bullet.radius || bullet.radius <=0) return;
        ctx.fillStyle = bullet.type === 'dodger' ? '#ff9800' : '#ffdd00'; // Orange for dodger, Yellow for shooter
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
        ctx.fill();
    });

     // --- Draw Explosions ---
    const now = Date.now();
    explosions.forEach(explosion => {
        const age = (now - explosion.startTime) / 1000;
        const progress = Math.min(1, age / EXPLOSION_DURATION); // Clamp progress 0-1

        const currentRadius = explosion.maxRadius * progress;
        const opacity = 1 - progress; // Fade out effect

        // Outer glow
        ctx.fillStyle = `rgba(255, 152, 0, ${opacity * 0.6})`; // Orange, fading
        ctx.beginPath();
        ctx.arc(explosion.x, explosion.y, currentRadius, 0, Math.PI * 2);
        ctx.fill();
        // Inner core (optional)
        ctx.fillStyle = `rgba(255, 224, 130, ${opacity * 0.4})`; // Lighter yellow/orange core
        ctx.beginPath();
        ctx.arc(explosion.x, explosion.y, currentRadius * 0.5, 0, Math.PI * 2);
        ctx.fill();
    });

    // --- Draw Players ---
    const allDrawablePlayers = [ // Combine local and remote players for drawing loop
         { ...localPlayer, clientId: room.clientId, ...(room.peers[room.clientId] || {}) },
         ...Object.values(players).map(p => ({ ...p })) // Map to include client ID if needed later
     ];

     allDrawablePlayers.forEach(p => {
         if (!p || !p.clientId) return; // Skip if player data is invalid

         if (p.dead) {
             // Draw dead indicator (e.g., a cross or gravestone)
             ctx.save();
             ctx.translate(p.x, p.y);
             ctx.strokeStyle = '#aaa';
             ctx.lineWidth = 3;
             ctx.beginPath();
             ctx.moveTo(-PLAYER_RADIUS * 0.7, -PLAYER_RADIUS * 0.7);
             ctx.lineTo(PLAYER_RADIUS * 0.7, PLAYER_RADIUS * 0.7);
             ctx.moveTo(PLAYER_RADIUS * 0.7, -PLAYER_RADIUS * 0.7);
             ctx.lineTo(-PLAYER_RADIUS * 0.7, PLAYER_RADIUS * 0.7);
             ctx.stroke();
             // Optionally draw username dimmed
              ctx.fillStyle = '#777';
              ctx.textAlign = 'center';
              ctx.font = '9px sans-serif';
              ctx.fillText(p.username || p.clientId.substring(0, 6), 0, -PLAYER_RADIUS - 8);
             ctx.restore();
         } else {
             // Draw alive player
             ctx.fillStyle = getPlayerColor(p.clientId);
             ctx.beginPath();
             ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
             ctx.fill();

             // Draw Health Bar above player
             drawPlayerHealthBar(ctx, p.x, p.y - PLAYER_RADIUS - 12, p.health, p.maxHealth);

             // Draw username above health bar
             ctx.fillStyle = '#fff';
             ctx.textAlign = 'center';
             ctx.font = '10px sans-serif';
             ctx.fillText(p.username || p.clientId.substring(0, 6), p.x, p.y - PLAYER_RADIUS - 18);
         }
     });


    // --- Restore Camera Transform ---
    ctx.restore();

    // --- Draw UI Elements (on top, not affected by camera) ---
    // Already handled by HTML/CSS elements
}

// Draw the health bar displayed above each player character in the world
function drawPlayerHealthBar(ctx, x, y, health, maxHealth) {
    const barWidth = PLAYER_RADIUS * 2.5; // Slightly wider than player
    const barHeight = 4;
    const healthPercentage = Math.max(0, health) / maxHealth;

    // Background (e.g., dark grey)
    ctx.fillStyle = 'rgba(85, 85, 85, 0.7)'; // #555 with some transparency
    ctx.fillRect(x - barWidth / 2, y - barHeight / 2, barWidth, barHeight);

    // Foreground (current health color-coded)
    let healthColor = '#4caf50'; // Green (default)
    if (healthPercentage < 0.3) healthColor = '#f44336'; // Red
    else if (healthPercentage < 0.6) healthColor = '#ff9800'; // Orange
    ctx.fillStyle = healthColor;
    ctx.fillRect(x - barWidth / 2, y - barHeight / 2, barWidth * healthPercentage, barHeight);

     // Optional: Border for clarity
    // ctx.strokeStyle = 'rgba(34, 34, 34, 0.7)'; // #222
    // ctx.lineWidth = 0.5;
    // ctx.strokeRect(x - barWidth / 2, y - barHeight / 2, barWidth, barHeight);
}

// Draw the background grid representing chunk boundaries
function drawChunkGrid() {
    const halfWidth = canvas.width / 2 / camera.zoom;
    const halfHeight = canvas.height / 2 / camera.zoom;
    const minX = camera.x - halfWidth;
    const maxX = camera.x + halfWidth;
    const minY = camera.y - halfHeight;
    const maxY = camera.y + halfHeight;

    // Determine the range of chunk coordinates to draw lines for
    const startChunkX = Math.floor(minX / CHUNK_SIZE) - 1; // Add buffer
    const endChunkX = Math.ceil(maxX / CHUNK_SIZE) + 1;
    const startChunkY = Math.floor(minY / CHUNK_SIZE) - 1;
    const endChunkY = Math.ceil(maxY / CHUNK_SIZE) + 1;

    ctx.lineWidth = 1;
    ctx.beginPath(); // Batch drawing lines

    // Draw vertical lines
    for (let cx = startChunkX; cx <= endChunkX; cx++) {
        const lineX = cx * CHUNK_SIZE;
        ctx.moveTo(lineX, startChunkY * CHUNK_SIZE);
        ctx.lineTo(lineX, endChunkY * CHUNK_SIZE);
    }
    // Draw horizontal lines
    for (let cy = startChunkY; cy <= endChunkY; cy++) {
        const lineY = cy * CHUNK_SIZE;
        ctx.moveTo(startChunkX * CHUNK_SIZE, lineY);
        ctx.lineTo(endChunkX * CHUNK_SIZE, lineY);
    }

    // Style and draw the basic grid
    ctx.strokeStyle = 'rgba(51, 51, 51, 0.7)'; // #333 with alpha
    ctx.stroke();

    // --- Highlight Spawn Area ---
    const spawnMinX = -SPAWN_CHUNK_RADIUS * CHUNK_SIZE;
    const spawnMinY = -SPAWN_CHUNK_RADIUS * CHUNK_SIZE;
    const spawnWidth = (SPAWN_CHUNK_RADIUS * 2) * CHUNK_SIZE; // Width = (max - min) * size
    const spawnHeight = (SPAWN_CHUNK_RADIUS * 2) * CHUNK_SIZE;// Height = (max - min) * size

    // Draw subtle background tint for spawn area
    ctx.fillStyle = 'rgba(0, 50, 80, 0.1)'; // Faint blue tint
    ctx.fillRect(spawnMinX, spawnMinY, spawnWidth, spawnHeight);

    // Draw border for spawn area
    ctx.strokeStyle = 'rgba(50, 150, 200, 0.3)'; // Light blue border, semi-transparent
    ctx.lineWidth = 2; // Make border slightly thicker
    ctx.strokeRect(spawnMinX, spawnMinY, spawnWidth, spawnHeight);
    ctx.lineWidth = 1; // Reset line width
}


// --- UI Updates ---

function toggleUiVisibility() {
    topLeftUiContainer.classList.toggle('hidden');
    // Update button icon/text based on visibility state
    if (topLeftUiContainer.classList.contains('hidden')) {
        toggleUiButton.textContent = '👁️';
        toggleUiButton.title = 'Show UI';
    } else {
        toggleUiButton.textContent = '✕';
        toggleUiButton.title = 'Hide UI';
    }
}

function updateHealthUI() {
    const healthPercentage = Math.max(0, (localPlayer.health / localPlayer.maxHealth) * 100);
    healthBarFill.style.width = `${healthPercentage}%`;

    // Change bar color based on health percentage
    if (healthPercentage < 30) healthBarFill.style.backgroundColor = '#f44336'; // Red
    else if (healthPercentage < 60) healthBarFill.style.backgroundColor = '#ff9800'; // Orange
    else healthBarFill.style.backgroundColor = '#4caf50'; // Green

    // Update health text display
    healthText.textContent = `Health: ${Math.round(localPlayer.health)}/${localPlayer.maxHealth}`;
}


function updateLeaderboard() {
    // Combine local player data with remote player data
     const allPlayersData = [
        {   // Local player data structure matching remote players
             clientId: room.clientId,
             ...(room.peers[room.clientId] || { username: 'You', avatarUrl: '' }), // Get own info safely
             score: localPlayer.score,
             dead: localPlayer.dead,
        },
        // Map remote player data, ensuring all needed properties exist
        ...Object.entries(players).map(([id, p]) => ({
            clientId: id,
            username: p.username || id.substring(0, 6),
            avatarUrl: p.avatarUrl || '',
            score: p.score ?? 0,
            dead: p.dead ?? false,
        }))
    ];


  // Sort players by score (descending)
  allPlayersData.sort((a, b) => b.score - a.score);

  // Clear previous leaderboard entries
  leaderboardList.innerHTML = '';

  // Populate leaderboard (e.g., top 10)
  allPlayersData.slice(0, 10).forEach(p => {
    const li = document.createElement('li');

    // Avatar image
    const img = document.createElement('img');
    img.src = p.avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${p.username || p.clientId}`; // Use identicon as fallback
    img.alt = p.username?.substring(0, 1) || '?';
    img.title = p.username || p.clientId;
    li.appendChild(img);

    // Name and Score text
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${p.username}: ${p.score}`;
    if (p.dead) {
        // Apply visual style for dead players (e.g., strike-through, grey color)
        nameSpan.style.textDecoration = 'line-through';
        nameSpan.style.color = '#aaa';
        img.style.filter = 'grayscale(80%)'; // Make avatar grey
    }
    li.appendChild(nameSpan);

    leaderboardList.appendChild(li);
  });
}


// --- Respawn and Resurrection Logic ---

function showRespawnPrompt() {
    respawnPrompt.classList.remove('hidden');
}

function hideRespawnPrompt() {
    respawnPrompt.classList.add('hidden');
}

// Called when the "Respawn" button is clicked
function handleRespawnButtonClick() {
    console.log("Respawn button clicked");
    respawnPlayer();
    hideRespawnPrompt();
}

// Logic to handle player respawning (teleport to spawn)
function respawnPlayer() {
    if (!localPlayer.dead) return; // Can only respawn if dead

    console.log("Respawning player at origin...");
    localPlayer.dead = false;
    localPlayer.health = localPlayer.maxHealth;
    localPlayer.x = 0; // Respawn at world origin (0,0)
    localPlayer.y = 0;
    localPlayer.vx = 0;
    localPlayer.vy = 0;
    localPlayer.timeOutsideSpawnMs = 0; // Reset score timer upon respawn

    // Update presence immediately to reflect respawn state
    room.updatePresence({
        dead: false,
        health: localPlayer.health,
        x: localPlayer.x,
        y: localPlayer.y,
        vx: 0,
        vy: 0,
        score: localPlayer.score // Keep score on respawn for now
    });

    // Update local UI elements
    updateHealthUI();
    updateLeaderboard(); // Show player as alive again

    // Center camera immediately on respawn
    camera.x = localPlayer.x;
    camera.y = localPlayer.y;
}

// Logic to handle being resurrected by another player
function resurrectPlayer(resurrectorClientId) {
     if (!localPlayer.dead) return; // Can only be resurrected if dead

    console.log(`Resurrected by ${resurrectorClientId}!`);
    localPlayer.dead = false;
    // Resurrect with partial health
    localPlayer.health = localPlayer.maxHealth * 0.5;
    localPlayer.vx = 0;
    localPlayer.vy = 0;
    // Player stays at the location where they died

    // Update presence immediately
    room.updatePresence({
        dead: false,
        health: localPlayer.health,
        x: localPlayer.x, // Keep current position
        y: localPlayer.y,
        vx: 0,
        vy: 0,
    });

     // Update local UI elements
     updateHealthUI();
     updateLeaderboard();
     hideRespawnPrompt(); // Hide the respawn prompt if it was visible
}


// --- Main Game Loop ---

let lastTimestamp = 0;
function gameLoop(timestamp) {
    // Calculate delta time in seconds
    const deltaTime = Math.min(0.1, (timestamp - lastTimestamp) / 1000); // Cap delta time to prevent large jumps
    lastTimestamp = timestamp;

    // --- Ensure Chunks Exist ---
    // Ensure current chunk and neighbors are loaded/generated
    const playerChunkId = getChunkId(localPlayer.x, localPlayer.y);
    ensureChunkExists(playerChunkId);
    const nearbyChunksForUpdate = getNearbyChunkIds(localPlayer.x, localPlayer.y, 1); // Radius 1 for updates
    nearbyChunksForUpdate.forEach(id => ensureChunkExists(id));

    // --- Game State Updates ---
    updatePlayer(deltaTime); // Update local player (movement, score, health regen, presence)
    updateNPCs(deltaTime); // Update NPCs (movement, shooting) in loaded chunks
    updateBullets(deltaTime); // Update bullets (movement, collision)
    updateExplosions(deltaTime); // Update active explosions (timing)

    // Periodic conflict checks (optional, as checks are triggered by data changes)
    // if (Math.random() < 0.01) { // ~ every 1.6 seconds at 60fps
    //     getVisibleChunkIds().forEach(checkForConflicts);
    // }

    // --- Rendering ---
    draw();

    // Request next frame
    requestAnimationFrame(gameLoop);
}

// --- Start Game ---
initializeGame().catch(error => {
    console.error("Failed to initialize game:", error);
    // Display error message to user?
});