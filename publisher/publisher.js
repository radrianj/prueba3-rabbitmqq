// /publisher/publisher.js

const mqtt = require('mqtt');
const config = require('../config');
//const axios = require("axios");
const fs = require('fs'); // ← FASE 3: Módulo para lectura/escritura de archivos
const path = require('path'); // ← FASE 3: Para manejar rutas de archivos

// --- Configuración Básica ---
const CLOCK_DRIFT_RATE = parseFloat(process.env.CLOCK_DRIFT_RATE || '0');
const DEVICE_ID = process.env.DEVICE_ID || 'sensor-default';
const PROCESS_ID = parseInt(process.env.PROCESS_ID || '0');

// --- Configuración de Elección (Bully) ---
const MY_PRIORITY = parseInt(process.env.PROCESS_PRIORITY || '0');
let currentLeaderPriority = 100; // Asumimos que hay alguien superior al inicio
let isCoordinator = false;
let electionInProgress = false;
let lastHeartbeatTime = Date.now();
const HEARTBEAT_INTERVAL = 2000; // Enviar PING cada 2s
const LEADER_TIMEOUT = 5000;     // Líder muerto si no responde en 5s
const ELECTION_TIMEOUT = 3000;   // Tiempo espera respuestas ALIVE


// ============================================================================
//          FASE 2: NUEVAS VARIABLES PARA LEASES Y QUÓRUM
// ============================================================================

// Variables para el sistema de Leases (Arrendamientos)
let myLeaseExpiration = 0;           // Timestamp de cuándo expira mi lease (si soy líder)
let lastSeenLeaderLease = Date.now(); // Última vez que vimos renovación del líder actual
const LEASE_DURATION = 5000;         // El lease dura 5 segundos
const LEASE_RENEWAL_INTERVAL = 2000; // El líder renueva cada 2 segundos
let leaseRenewalTimer = null;        // Timer para renovaciones automáticas

// Variables para el sistema de Quórum
let electionVotes = new Set();       // Set de IDs que votaron por mí en la elección actual
let electionStartTime = 0;           // Timestamp de cuándo iniciamos la elección
const QUORUM_SIZE = 3;               // Necesitamos 3 votos de 5 nodos (mayoría simple)
let amICandidate = false;            // ¿Estoy en modo candidato esperando quórum?

// Parsear lista de participantes para saber cuántos nodos existen
const participantsEnv = process.env.ELECTION_PARTICIPANTS || '';
const participantsList = participantsEnv.split(',').map(p => {
  const [id, prio] = p.split(':');
  return { id: id.trim(), priority: parseInt(prio) };
});
const TOTAL_NODES = participantsList.length;

console.log(`[INIT] Participantes en la red: ${TOTAL_NODES} nodos`);
console.log(`[INIT] Quórum requerido: ${QUORUM_SIZE} votos`);
//-------------------------

// ============================================================================
//          FASE 3: VARIABLES PARA WRITE-AHEAD LOG (WAL)
// ============================================================================

// Ruta del archivo WAL (Write-Ahead Log)
const WAL_FILE_PATH = path.join(__dirname, 'wal.log');

// Flag para saber si ya recuperamos el estado del WAL
let walRecovered = false;
//---------------------------

// --- Estado Mutex (Cliente) ---
let sensorState = 'IDLE';
const CALIBRATION_INTERVAL_MS = 20000 + (Math.random() * 5000);
const CALIBRATION_DURATION_MS = 5000;

// --- Estado Mutex (Servidor/Coordinador) - SOLO SE USA SI isCoordinator = true ---
let coord_isLockAvailable = true;
let coord_lockHolder = null;
let coord_waitingQueue = [];

// --- Sincronización Reloj (Cristian, Lamport, Vector) ---
// ... (Variables reducidas para brevedad, la lógica se mantiene)
let lastRealTime = Date.now();
let lastSimulatedTime = Date.now();
let clockOffset = 0;
let lamportClock = 0;
const VECTOR_PROCESS_COUNT = 3;
let vectorClock = new Array(VECTOR_PROCESS_COUNT).fill(0);

// --- Conexión MQTT ---
const statusTopic = config.topics.status(DEVICE_ID);
const brokerUrl = `mqtt://${config.broker.address}:${config.broker.port}`;
const client = mqtt.connect(brokerUrl, {
  clientId: `pub_${DEVICE_ID}_${Math.random().toString(16).slice(2, 5)}`,
  will: { topic: statusTopic, payload: JSON.stringify({ deviceId: DEVICE_ID, status: 'offline' }), qos: 1, retain: true }
});

// ============================================================================
//                            LÓGICA DEL CICLO DE VIDA
// ============================================================================

client.on('connect', () => {
  console.log(`[INFO] ${DEVICE_ID} (Prio: ${MY_PRIORITY}) conectado.`);

  // 1. Suscripciones Básicas
  client.subscribe(config.topics.time_response(DEVICE_ID));
  client.subscribe(config.topics.mutex_grant(DEVICE_ID));

  // 2. Suscripciones de Elección
  client.subscribe(config.topics.election.heartbeat); // Escuchar PONG
  client.subscribe(config.topics.election.messages);  // Escuchar ELECTION, ALIVE
  client.subscribe(config.topics.election.coordinator); // Escuchar VICTORY

  // ============================================================================
  //          FASE 2: NUEVA SUSCRIPCIÓN - Lease del Líder
  // ============================================================================
  client.subscribe('utp/sistemas_distribuidos/grupo1/election/lease', { qos: 1 });
  client.subscribe('utp/sistemas_distribuidos/grupo1/election/vote_ack', { qos: 1 });

  // 3. Iniciar Ciclos
  // A. Telemetría
  setInterval(publishTelemetry, 5000);
  // B. Sincronización Reloj (Cristian)
  setInterval(syncClock, 30000);
  // C. Intentos de Calibración (Cliente Mutex)
  setTimeout(() => { setInterval(requestCalibration, CALIBRATION_INTERVAL_MS); }, 5000);

  // D. Monitoreo del Líder (Heartbeat Check)
  setInterval(checkLeaderStatus, 1000);

  // E. Enviar Heartbeats (PING)
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // ============================================================================
  //          FASE 2: NUEVO - Monitoreo de Lease del Líder
  // ============================================================================
  // F. Verificar expiración del lease del líder actual
  setInterval(checkLeaseExpiration, 1000);

  // Publicar estado online
  client.publish(statusTopic, JSON.stringify({ deviceId: DEVICE_ID, status: 'online' }), { retain: true });

  // ============================================================================
  //          FASE 3: LIMPIEZA PERIÓDICA DEL WAL (Opcional)
  // ============================================================================
  // Limpiar el WAL cada 5 minutos si somos líder y la cola está vacía
  setInterval(() => {
    if (isCoordinator && coord_waitingQueue.length === 0 && coord_isLockAvailable) {
      console.log(`[WAL] Sistema estable. Limpiando WAL...`);
      truncateWAL();
    }
  }, 300000); // 5 minutos


});

client.on('message', (topic, message) => {
  const payload = JSON.parse(message.toString());

  // ============================================================================
  //          FASE 2: MANEJO DE LEASES Y VOTOS
  // ============================================================================
  
  // A. Renovación de Lease del Líder
  if (topic === 'utp/sistemas_distribuidos/grupo1/election/lease') {
    // Un líder publicó su lease, actualizamos el timestamp
    if (payload.priority > MY_PRIORITY || (payload.priority === MY_PRIORITY && isCoordinator)) {
      lastSeenLeaderLease = Date.now();
      console.log(`[LEASE] Lease renovado por líder (Prioridad: ${payload.priority})`);
      
      // Si yo era candidato o líder, pero veo un lease de alguien con más prioridad, me bajo
      if (payload.priority > MY_PRIORITY && (isCoordinator || amICandidate)) {
        console.log(`[LEASE] Detectado líder superior. Stepping down.`);
        stepDownFromLeadership();
      }
    }
    return;
  }

  // B. Recepción de Votos (ACK)
  if (topic === 'utp/sistemas_distribuidos/grupo1/election/vote_ack') {
    // Alguien votó por mí
    if (payload.votesFor === MY_PRIORITY && amICandidate) {
      electionVotes.add(payload.voterId);
      console.log(`[QUORUM] Voto recibido de ${payload.voterId}. Total: ${electionVotes.size}/${QUORUM_SIZE}`);
      
      // Si alcanzamos quórum, nos declaramos líder
      if (electionVotes.size >= QUORUM_SIZE) {
        declareVictory();
      }
    }
    return;
  }
// ============================================================================

  // --- 1. MANEJO DE ELECCIÓN (Bully) ---
  if (topic.startsWith('utp/sistemas_distribuidos/grupo1/election')) {
    handleElectionMessages(topic, payload);
    return;
  }

  // --- 2. SI SOY COORDINADOR: MANEJAR SOLICITUDES MUTEX ---
  if (isCoordinator) {
    if (topic === config.topics.mutex_request) {
      handleCoordRequest(payload.deviceId);
      return;
    }
    if (topic === config.topics.mutex_release) {
      handleCoordRelease(payload.deviceId);
      return;
    }
  }

  // --- 3. SI SOY CLIENTE: MANEJAR RESPUESTAS ---
  if (topic === config.topics.mutex_grant(DEVICE_ID)) {
    if (sensorState === 'REQUESTING') {
      console.log(`[MUTEX-CLIENT] Permiso recibido.`);
      sensorState = 'CALIBRATING';
      enterCriticalSection();
    }
  }

  // --- 4. SINCRONIZACIÓN DE RELOJ (CRISTIAN) ---
  if (topic === config.topics.time_response(DEVICE_ID)) {
    /*const rtt = Date.now() - (payload.t1 || Date.now()); // Simplificado
    const correctTime = payload.serverTime + (rtt / 2);
    clockOffset = correctTime - getSimulatedTime().getTime();*/
    handleTimeResponse(payload);
    return;
  }
});

// ============================================================================
//          FASE 2: FUNCIONES PARA SISTEMA DE LEASES Y QUÓRUM
// ============================================================================

/**
 * Verifica si el lease del líder actual ha expirado.
 * Si expira, inicia una nueva elección.
 */
function checkLeaseExpiration() {
  // Si somos el líder, verificamos si nuestro propio lease expiró
  if (isCoordinator) {
    const now = Date.now();
    if (now > myLeaseExpiration) {
      console.warn(`⚠️ [LEASE] Mi propio lease expiró. Debo renovarlo o perder el liderazgo.`);
      // Nota: Esto no debería pasar si leaseRenewalTimer funciona bien
      // Pero es una protección por si el timer falla
    }
    return; // Si somos líder, no monitoreamos a otros
  }

  // Si NO somos líder, verificamos si el líder actual sigue renovando
  const timeSinceLastLease = Date.now() - lastSeenLeaderLease;
  
  if (timeSinceLastLease > LEASE_DURATION && !electionInProgress && !amICandidate) {
    console.warn(`⚠️ [LEASE] Líder no renovó lease en ${timeSinceLastLease}ms. Iniciando elección.`);
    startElection();
  }
}

/**
 * Renueva el lease del líder publicando en el tópico retenido.
 * Solo se ejecuta si somos el coordinador.
 */
function renewLease() {
  if (!isCoordinator) {
    // Si ya no somos líder, cancelamos las renovaciones
    if (leaseRenewalTimer) {
      clearInterval(leaseRenewalTimer);
      leaseRenewalTimer = null;
    }
    return;
  }

  // Actualizamos la expiración de nuestro lease
  myLeaseExpiration = Date.now() + LEASE_DURATION;

  // Publicamos el lease en un tópico RETENIDO (retain: true)
  const leaseMsg = JSON.stringify({
    leaderId: DEVICE_ID,
    priority: MY_PRIORITY,
    expiresAt: myLeaseExpiration,
    timestamp: Date.now()
  });

  client.publish('utp/sistemas_distribuidos/grupo1/election/lease', leaseMsg, { 
    qos: 1, 
    retain: true // IMPORTANTE: El mensaje se mantiene en el broker
  });

  console.log(`[LEASE] Lease renovado. Expira en ${LEASE_DURATION}ms.`);
}

/**
 * Deja el liderazgo (por lease expirado o líder superior detectado).
 */
function stepDownFromLeadership() {
  if (!isCoordinator && !amICandidate) return;

  console.log(`[ROLE] *** STEPPING DOWN from leadership ***`);
  
  isCoordinator = false;
  amICandidate = false;
  electionInProgress = false;
  electionVotes.clear();

  // Cancelar renovaciones de lease
  if (leaseRenewalTimer) {
    clearInterval(leaseRenewalTimer);
    leaseRenewalTimer = null;
  }

  // Dejar de manejar mutex
  client.unsubscribe(config.topics.mutex_request);
  client.unsubscribe(config.topics.mutex_release);

  // Resetear timestamp de monitoreo
  lastSeenLeaderLease = Date.now();
}

//=======

// ============================================================================
//                          ALGORITMO DE ELECCIÓN (BULLY)
// ============================================================================

function sendHeartbeat() {
  // Solo enviamos PING si NO somos el coordinador
  if (!isCoordinator) {
    client.publish(config.topics.election.heartbeat, JSON.stringify({ type: 'PING', fromPriority: MY_PRIORITY }));
  }
}

function checkLeaderStatus() {
  if (isCoordinator) return; // Si soy líder, no monitoreo a nadie

  // Si pasó mucho tiempo desde el último PONG o mensaje del líder
  if (Date.now() - lastHeartbeatTime > LEADER_TIMEOUT) {
    console.warn(`[BULLY] ¡Líder caído! (Timeout). Iniciando elección.`);
    startElection();
  }
}

//se modifica la elección para incluir quórum
function startElection() {
  if (electionInProgress || amICandidate) return;
  electionInProgress = true;
  amICandidate = true;
  electionVotes.clear();// Reiniciar votos
  electionStartTime = Date.now();// Marcar inicio de elección
  lastHeartbeatTime = Date.now(); // Reset timer para no spammear

  console.log(`[BULLY] Convocando elección... Buscando nodos con prioridad > ${MY_PRIORITY}`);


  // ============================================================================
  //          NUEVA LÓGICA - Sistema de Votación con Quórum
  // ============================================================================

  // 1. Enviar mensaje ELECTION a todos los nodos con prioridad superior
  client.publish(config.topics.election.messages, JSON.stringify({
    type: 'ELECTION',
    fromPriority: MY_PRIORITY,
    fromId: DEVICE_ID, // Para que sepan quién inició la elección
    timestamp: Date.now() // Marca temporal del inicio de la elección
  }));

  // 2. Nos auto-votamos (1 de 3 votos necesarios)
  electionVotes.add(DEVICE_ID); // Contamos nuestro propio voto
  console.log(`[QUORUM] Auto-voto registrado. Total: ${electionVotes.size}/${QUORUM_SIZE}`);

  // 3. Pedimos votos a nodos con prioridad MENOR (ellos deben votarnos)
  client.publish('utp/sistemas_distribuidos/grupo1/election/vote_request', JSON.stringify({
    type: 'VOTE_REQUEST',
    candidatePriority: MY_PRIORITY,
    candidateId: DEVICE_ID,
    timestamp: Date.now()
  }));


  // 2. Esperar respuestas ALIVE por un tiempo limitado
  setTimeout(() => {
    if (amICandidate) {
      // Si llegamos aquí y no recibimos ALIVE de nadie superior.
      // verificamos si alcanzamos quórum
      if (electionVotes.size >= QUORUM_SIZE) {
        console.log(`[QUORUM] ¡Quórum alcanzado! (${electionVotes.size}/${QUORUM_SIZE} votos)`);
        declareVictory();
      } else {
        console.warn(`⚠️ [QUORUM] No se alcanzó quórum (${electionVotes.size}/${QUORUM_SIZE}). Esperando...`);
        amICandidate = false;
        electionInProgress = false;
        // No nos declaramos líder, seguimos como seguidores
      }
    }
  }, ELECTION_TIMEOUT);
}

function handleElectionMessages(topic, payload) {
  // ============================================================================
  //          FASE 2: MANEJO DE SOLICITUDES DE VOTOS
  // ============================================================================
  // Alguien nos pide nuestro voto
  if (topic === 'utp/sistemas_distribuidos/grupo1/election/vote_request') {
    const candidatePriority = payload.candidatePriority;
    const candidateId = payload.candidateId;
    
    // Solo votamos si el candidato tiene prioridad MAYOR que nosotros
    if (candidatePriority > MY_PRIORITY) {
      console.log(`[QUORUM] Votando por candidato ${candidateId} (Prioridad: ${candidatePriority})`);

      // Votamos si:
      // 1. El candidato tiene prioridad MAYOR que nosotros (es superior)
      // 2. O si estamos en medio de una elección y nadie mejor ha aparecido

      // Votamos si:
      // 1. El candidato tiene prioridad MAYOR que nosotros (es superior)
      // 2. O si estamos en medio de una elección y nadie mejor ha aparecido
      
      if (shouldVote) {
      console.log(`[QUORUM] ✅ Votando por candidato ${candidateId} (Prioridad: ${candidatePriority})`);
      client.publish('utp/sistemas_distribuidos/grupo1/election/vote_ack', JSON.stringify({
        type: 'VOTE_ACK',
        votesFor: candidatePriority,
        voterId: DEVICE_ID,
        timestamp: Date.now()
      }));
    } else {
      console.log(`[QUORUM] ❌ Rechazando voto para ${candidateId} (prioridad ${candidatePriority} < mi prioridad ${MY_PRIORITY})`);
    }
    return;
  }
  // ============================================================================

  // A. HEARTBEATS
  if (topic === config.topics.election.heartbeat) {
    if (payload.type === 'PONG' && payload.fromPriority > MY_PRIORITY) {
      // El líder respondió, todo está bien.
      lastHeartbeatTime = Date.now();
    }
    return;
  }

  // B. MENSAJES DE ELECCIÓN
  if (topic === config.topics.election.messages) {
    // Si alguien con MENOR prioridad inicia elección, le decimos que estamos vivos
    if (payload.type === 'ELECTION' && payload.fromPriority < MY_PRIORITY) {
      console.log(`[BULLY] Recibida elección de inferior (${payload.fromPriority}). Enviando ALIVE.`);
      client.publish(config.topics.election.messages, JSON.stringify({
        type: 'ALIVE', toPriority: payload.fromPriority, fromPriority: MY_PRIORITY
      }));
      // E iniciamos nuestra propia elección por si acaso el líder real murió
      startElection();
    }
    // Si recibimos ALIVE de alguien SUPERIOR, nos callamos y esperamos
    else if (payload.type === 'ALIVE' && payload.fromPriority > MY_PRIORITY) {
      console.log(`[BULLY] Recibido ALIVE de superior (${payload.fromPriority}). Me retiro.`);
      electionInProgress = false; // Dejamos de intentar ser líderes
    }
    return;
  }

  // C. ANUNCIO DE COORDINADOR (VICTORY)
  if (topic === config.topics.election.coordinator) {
    console.log(`[BULLY] Nuevo Coordinador electo: ${payload.coordinatorId} (Prio: ${payload.priority})`);
    currentLeaderPriority = payload.priority;
    lastHeartbeatTime = Date.now(); // El líder está vivo
    electionInProgress = false;

    // Chequear si soy yo (por si acaso)
    if (payload.priority === MY_PRIORITY) {
      becomeCoordinator();
    } else {
      isCoordinator = false;
      // Dejar de escuchar peticiones de mutex si antes era coordinador
      client.unsubscribe(config.topics.mutex_request);
      client.unsubscribe(config.topics.mutex_release);
    }
  }
}

function declareVictory() {
  console.log(`[BULLY] ¡Nadie superior respondió! ME DECLARO COORDINADOR.`);
  const msg = JSON.stringify({ type: 'VICTORY', coordinatorId: DEVICE_ID, priority: MY_PRIORITY });
  client.publish(config.topics.election.coordinator, msg, { retain: true });
  becomeCoordinator();
}

function becomeCoordinator() {
  if (isCoordinator) return;
  console.log(`[ROLE] *** ASCENDIDO A COORDINADOR DE BLOQUEO ***`);

  // ============================================================================
  //          FASE 3: RECUPERAR ESTADO DEL WAL ANTES DE OPERAR
  // ============================================================================
  recoverFromWAL();

  isCoordinator = true;
  amICandidate = false;
  electionInProgress = false;
  electionVotes.clear(); // Reiniciar votos

  // ============================================================================
  //          FASE 2: INICIAR SISTEMA DE LEASES
  // ============================================================================

  // Establecer el lease inicial
  myLeaseExpiration = Date.now() + LEASE_DURATION;
  
  // Renovar el lease inmediatamente
  renewLease();

  // Configurar renovaciones automáticas cada 2 segundos
  if (leaseRenewalTimer) clearInterval(leaseRenewalTimer);
  leaseRenewalTimer = setInterval(renewLease, LEASE_RENEWAL_INTERVAL);
  
  console.log(`[LEASE] Sistema de leases activado (renovación cada ${LEASE_RENEWAL_INTERVAL}ms)`);

  // NOTA: NO reiniciamos el estado del mutex aquí, porque ya lo recuperamos del WAL
  // Si el WAL estaba vacío, recoverFromWAL() ya lo dejó limpio

  /*// Reiniciar estado del mutex (para evitar bloqueos heredados)
  coord_isLockAvailable = true;
  coord_lockHolder = null;
  coord_waitingQueue = [];*/

  // Suscribirse a los tópicos que debe escuchar el líder
  client.subscribe(config.topics.mutex_request, { qos: 1 });
  client.subscribe(config.topics.mutex_release, { qos: 1 });

  // Publicar estado inicial
  publishCoordStatus();
}

// ============================================================================
//          FASE 3: FUNCIONES PARA WRITE-AHEAD LOG (WAL)
// ============================================================================

/**
 * Escribe una operación en el WAL (Write-Ahead Log).
 * Esto asegura que si el líder se cae, podamos recuperar el estado.
 * 
 * @param {string} operation - Tipo de operación: 'REQUEST', 'GRANT', 'RELEASE'
 * @param {string} deviceId - ID del dispositivo involucrado
 */
function writeToWAL(operation, deviceId) {
  try {
    const timestamp = new Date().toISOString(); // Timestamp de la operación
    const logEntry = JSON.stringify({  // Estructura del log
      timestamp, 
      operation, 
      deviceId 
    }) + '\n';
    
    // Escribir de forma síncrona para garantizar persistencia inmediata
    fs.appendFileSync(WAL_FILE_PATH, logEntry, 'utf8');
    
    console.log(`[WAL] Operación registrada: ${operation} - ${deviceId}`);
  } catch (error) {
    console.error(`[WAL ERROR] No se pudo escribir en el log:`, error);
  }
}

/**
 * Lee el WAL y reconstruye el estado de la cola de espera.
 * Se ejecuta al convertirse en líder.
 */
function recoverFromWAL() {
  if (walRecovered) {
    console.log(`[WAL] Estado ya recuperado previamente.`);
    return;
  }

  console.log(`[WAL] Iniciando recuperación de estado...`);
  
  // Verificar si el archivo WAL existe
  if (!fs.existsSync(WAL_FILE_PATH)) {
    console.log(`[WAL] No se encontró archivo WAL. Iniciando con estado limpio.`);
    walRecovered = true;
    return;
  }

  try {
    // Leer el contenido completo del archivo
    const walContent = fs.readFileSync(WAL_FILE_PATH, 'utf8');
    const lines = walContent.split('\n').filter(line => line.trim() !== '');
    
    console.log(`[WAL] Leyendo ${lines.length} entradas del log...`);

    // Estructuras temporales para reconstruir el estado
    let tempQueue = [];
    let tempHolder = null;
    let tempLockAvailable = true;

    // Procesar cada entrada del log
    lines.forEach((line, index) => {
      try {
        const entry = JSON.parse(line);
        const { operation, deviceId } = entry;

        switch (operation) {
          case 'REQUEST':
            // Alguien solicitó el recurso
            if (!tempQueue.includes(deviceId) && tempHolder !== deviceId) {
              tempQueue.push(deviceId);
              console.log(`[WAL] Recuperado REQUEST de ${deviceId}`);
            }
            break;

          case 'GRANT':
            // Se otorgó el recurso a alguien
            tempHolder = deviceId;
            tempLockAvailable = false;
            // Remover de la cola si estaba ahí
            tempQueue = tempQueue.filter(id => id !== deviceId);
            console.log(`[WAL] Recuperado GRANT a ${deviceId}`);
            break;

          case 'RELEASE':
            // Alguien liberó el recurso
            if (tempHolder === deviceId) {
              tempHolder = null;
              tempLockAvailable = true;
              console.log(`[WAL] Recuperado RELEASE de ${deviceId}`);
            }
            break;

          default:
            console.warn(`[WAL] Operación desconocida: ${operation}`);
        }
      } catch (parseError) {
        console.error(`[WAL ERROR] No se pudo parsear línea ${index + 1}:`, parseError);
      }
    });

    // Aplicar el estado reconstruido
    coord_waitingQueue = tempQueue;
    coord_lockHolder = tempHolder;
    coord_isLockAvailable = tempLockAvailable;

    console.log(`[RECOVERY] Restored queue: [${coord_waitingQueue.join(', ')}]`);
    console.log(`[RECOVERY] Lock holder: ${coord_lockHolder || 'None'}`);
    console.log(`[RECOVERY] Lock available: ${coord_isLockAvailable}`);

    walRecovered = true;

  } catch (error) {
    console.error(`[WAL ERROR] Error durante recuperación:`, error);
    // En caso de error, iniciamos con estado limpio
    coord_waitingQueue = [];
    coord_lockHolder = null;
    coord_isLockAvailable = true;
    walRecovered = true;
  }
}

/**
 * Limpia el archivo WAL (opcional, para empezar desde cero).
 * Se puede llamar cuando el sistema esté estable y queramos resetear el log.
 */
function truncateWAL() {
  try {
    if (fs.existsSync(WAL_FILE_PATH)) {
      fs.writeFileSync(WAL_FILE_PATH, '', 'utf8');
      console.log(`[WAL] Archivo WAL limpiado.`);
    }
  } catch (error) {
    console.error(`[WAL ERROR] No se pudo limpiar el WAL:`, error);
  }
}
// ============================================================================


// ============================================================================
//                  LÓGICA DE SERVIDOR MUTEX (Solo si isCoordinator)
// ============================================================================
// (Esta lógica es idéntica a la de lock-coordinator.js, ahora embebida aquí)

function handleCoordRequest(requesterId) {
  console.log(`[COORD] Procesando solicitud de: ${requesterId}`);

  // ============================================================================
  //          FASE 3: REGISTRAR OPERACIÓN EN WAL
  // ============================================================================
  writeToWAL('REQUEST', requesterId); // Registrar solicitud

  if (coord_isLockAvailable) {
    grantCoordLock(requesterId); // Otorgar el lock
  } else {
    if (!coord_waitingQueue.includes(requesterId) && coord_lockHolder !== requesterId) { // Evitar duplicados
      coord_waitingQueue.push(requesterId); // Agregar a la cola
      console.log(`[COORD] ${requesterId} agregado a la cola. Cola actual: [${coord_waitingQueue.join(', ')}]`); // Mostrar cola
    }
  }
  publishCoordStatus();
}

function handleCoordRelease(requesterId) {
  if (coord_lockHolder === requesterId) {
    console.log(`[COORD] Liberado por: ${requesterId}`);

    // ============================================================================
    //          FASE 3: REGISTRAR OPERACIÓN EN WAL
    // ============================================================================
    writeToWAL('RELEASE', requesterId); // Registrar liberación

    coord_lockHolder = null; // Liberar el lock
    coord_isLockAvailable = true; // Marcar como disponible

    // Otorgar el lock al siguiente en la cola, si hay alguien esperando
    if (coord_waitingQueue.length > 0) {
      const nextInQueue = coord_waitingQueue.shift(); // Sacar el siguiente de la cola
      console.log(`[COORD] Atendiendo siguiente en cola: ${nextInQueue}`); //
      grantCoordLock(coord_waitingQueue.shift());
    }
  }
  publishCoordStatus();
}

function grantCoordLock(requesterId) {
  coord_isLockAvailable = false;
  coord_lockHolder = requesterId;

  // ============================================================================
  //          FASE 3: REGISTRAR OPERACIÓN EN WAL
  // ============================================================================
  writeToWAL('GRANT', requesterId); // Registrar concesión

  console.log(`[COORD] Lock otorgado a: ${requesterId}`);
  client.publish(config.topics.mutex_grant(requesterId), JSON.stringify({ status: 'granted' }), { qos: 1 });
}

function publishCoordStatus() {
  client.publish(config.topics.mutex_status, JSON.stringify({
    isAvailable: coord_isLockAvailable,
    holder: coord_lockHolder,
    queue: coord_waitingQueue
  }), { retain: true });
}

// ============================================================================
//                            FUNCIONES AUXILIARES
// ============================================================================

function getSimulatedTime() {
  const now = Date.now();
  const realElapsed = now - lastRealTime;
  const simulatedElapsed = realElapsed + (realElapsed * CLOCK_DRIFT_RATE / 1000);
  lastSimulatedTime = lastSimulatedTime + simulatedElapsed;
  lastRealTime = now;
  return new Date(Math.floor(lastSimulatedTime));
}

//Variables para rastrear la sincronización
let syncRequestTime = 0;// T1: Momento en que enviamos la petición
function syncClock() {
  syncRequestTime = Date.now();// Guardamos el timestamp ANTES de enviar la petición (T1)

  const payload = JSON.stringify({ deviceId: DEVICE_ID, t1: syncRequestTime });// Enviamos nuestro T1 al servidor
  console.log(`[CRISTIAN] Solicitando sincronización de reloj...`);
  client.publish(config.topics.time_request, payload, { qos: 0 });
}

function handleTimeResponse(payload) {
  // T2: Momento en que recibimos la respuesta
  const T2 = Date.now();
  
  // Calculamos el RTT (Round Trip Time)
  // RTT = Tiempo total que tardó el mensaje en ir y volver
  const RTT = T2 - syncRequestTime;
  
  console.log(`[CRISTIAN] RTT calculado: ${RTT}ms`);
  
  // VALIDACIÓN: Si el RTT es mayor a 500ms, la sincronización no es confiable
  if (RTT > 500) {
    console.warn(`⚠️ [CRISTIAN] Sincronización descartada: RTT demasiado alto (${RTT}ms > 500ms)`);
    return; // Descartamos esta sincronización
  }
  // Si el RTT es aceptable, calculamos el tiempo corregido
  // Asumimos que el delay de ida es igual al de vuelta (RTT/2)
  const serverTime = payload.serverTime || Date.now();
  const estimatedDelay = RTT / 2;
  const correctedTime = serverTime + estimatedDelay;
  
  // Calculamos el offset (diferencia entre nuestro reloj y el del servidor)
  const currentLocalTime = getSimulatedTime().getTime();
  clockOffset = correctedTime - currentLocalTime;
  
  console.log(`✅ [CRISTIAN] Reloj sincronizado. Offset ajustado: ${clockOffset.toFixed(0)}ms`);
}

function requestCalibration() {
  if (sensorState === 'IDLE' && !isCoordinator) { // El coordinador no se auto-solicita en este ejemplo simple
    console.log(`[MUTEX-CLIENT] Solicitando...`);
    sensorState = 'REQUESTING';
    client.publish(config.topics.mutex_request, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
  }
}

function enterCriticalSection() {
  setTimeout(() => {
    console.log(`[MUTEX-CLIENT] Fin calibración.`);
    releaseLock();
  }, CALIBRATION_DURATION_MS);
}

function releaseLock() {
  sensorState = 'IDLE';
  client.publish(config.topics.mutex_release, JSON.stringify({ deviceId: DEVICE_ID }), { qos: 1 });
}

function publishTelemetry() {
  lamportClock++;
  vectorClock[PROCESS_ID]++;
  const correctedTime = new Date(getSimulatedTime().getTime() + clockOffset);
  

  const telemetryData = {
    deviceId: DEVICE_ID,
    temperatura: (Math.random() * 30).toFixed(2),
    humedad: (Math.random() * 100).toFixed(2),
    timestamp: correctedTime.toISOString(),
    timestamp_simulado: getSimulatedTime().toISOString(),
    clock_offset: clockOffset.toFixed(0),
    lamport_ts: lamportClock,
    vector_clock: [...vectorClock],
    sensor_state: isCoordinator ? 'COORDINATOR' : sensorState // Mostrar rol especial si es líder
  };
  client.publish(config.topics.telemetry(DEVICE_ID), JSON.stringify(telemetryData));
}