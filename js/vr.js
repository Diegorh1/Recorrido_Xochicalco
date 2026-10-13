/**
 * MÓDULO WEBXR / A-FRAME — RECORRIDO VIRTUAL XOCHICALCO
 * Controlado 100% con la mirada (Gaze-Fuse) para visores móviles tipo Cardboard.
 */

const JSON_URL = 'tour.json';
const RIG_HEIGHT = 1.6;
const HOTSPOT_RADIUS = 4.0;
const PANEL_RADIUS = 2.45;

// Definición exacta de los 12 pines del mapa del museo (sincronizados con index.html)
const MAP_PINS_CONFIG = [
  { scenes: ['imagen7'], top: 85, left: 20, title: 'Entrada al museo' },
  { scenes: ['imagen8', 'imagen9'], top: 78, left: 18, title: 'Taquilla' },
  { scenes: ['imagen10'], top: 63, left: 17, title: 'Sala de introducción' },
  { scenes: ['imagen11', 'imagen14', 'imagen15', 'imagen16'], top: 63, left: 44, title: 'Pasillo de las joyas' },
  { scenes: ['imagen17'], top: 63, left: 70, title: 'Acceso Salas 1, 2 y 3' },
  { scenes: ['imagen18', 'imagen19', 'imagen20'], top: 70, left: 76, title: 'Sala 1: Los dones de la Tierra' },
  { scenes: ['imagen21', 'imagen22', 'imagen23'], top: 63, left: 82, title: 'Sala 2: Hombres guerreros' },
  { scenes: ['imagen24', 'imagen25', 'imagen26'], top: 57, left: 82, title: 'Sala 3: Resguardo de hombres' },
  { scenes: ['imagen27'], top: 54, left: 70, title: 'Pasillo cronológico' },
  { scenes: ['imagen28'], top: 40, left: 63, title: 'Acceso Salas 4 y 5' },
  { scenes: ['imagen32'], top: 50, left: 50, title: 'Sala 4: Manos creadoras' },
  { scenes: ['imagen29', 'imagen30', 'imagen31'], top: 40, left: 50, title: 'Sala 5: Rituales del juego' }
];

let tourData = null;
let currentSceneId = '';

// Estado de la tarjeta 3D activa
let activeCardState = {
  isOpen: false,
  lang: 'es', // 'es' | 'en'
  pageIndex: 0,
  pagesEs: [],
  pagesEn: [],
  titleEs: '',
  titleEn: '',
  hasEnglish: false,
  imgSrc: null,
  loadedImage: null,
  imageOnly: false
};

// Estado del modo "Mover Hotspot con la Mirada"
let gazeMoveMode = false;
let grabbedHotspot = null; // { entity, hsData, index }
let gazeFollowTick = null;

// Cache de imágenes cargadas para Canvas 2D
const imageCache = new Map();

// ========================================================
// 1. MATEMÁTICA ESFÉRICA: Pannellum (Pitch/Yaw) -> WebXR (X,Y,Z)
// ========================================================
function pannellumToCartesian(pitch, yaw, radius = HOTSPOT_RADIUS) {
  const radYaw = Number(yaw) * (Math.PI / 180);
  const radPitch = Number(pitch) * (Math.PI / 180);

  const x = radius * Math.cos(radPitch) * Math.sin(radYaw);
  const y = RIG_HEIGHT + radius * Math.sin(radPitch);
  const z = -radius * Math.cos(radPitch) * Math.cos(radYaw);

  return `${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`;
}

function getCameraPitchYaw() {
  const cameraEl = document.querySelector('#main-camera');
  if (!cameraEl || !cameraEl.object3D) return { pitch: 0, yaw: 0 };

  const direction = new THREE.Vector3(0, 0, -1);
  direction.applyQuaternion(cameraEl.object3D.quaternion);
  direction.normalize();

  const pitch = Math.asin(Math.max(-1, Math.min(1, direction.y))) * (180 / Math.PI);
  const yaw = Math.atan2(direction.x, -direction.z) * (180 / Math.PI);

  return {
    pitch: Number(pitch.toFixed(1)),
    yaw: Number(yaw.toFixed(1))
  };
}

// ========================================================
// 2. UTILIDADES DE RENDERIZADO EN CANVAS 2D -> TEXTURA WEBGL
// ========================================================
function applyCanvasTexture(entityEl, canvas) {
  if (!entityEl) return;
  const applyTex = () => {
    const mesh = entityEl.getObject3D('mesh');
    if (!mesh) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    if (mesh.material) {
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = texture;
      mesh.material.transparent = true;
      mesh.material.needsUpdate = true;
    }
  };

  if (entityEl.getObject3D('mesh')) {
    applyTex();
  } else {
    entityEl.addEventListener('loaded', applyTex, { once: true });
  }
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderButtonPlane(planeEl, label, bgColor = '#1A2525', borderColor = '#D4AF37', textColor = '#FFFFFF') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawRoundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 28);
  ctx.fillStyle = bgColor;
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.font = 'bold 42px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 48);

  applyCanvasTexture(planeEl, canvas);
}

function createFloatingLabelEntity(text, borderColor = '#D4AF37', yOffset = 0.34) {
  const plane = document.createElement('a-plane');
  plane.setAttribute('position', `0 ${yOffset} 0`);
  plane.setAttribute('width', '1.35');
  plane.setAttribute('height', '0.32');
  plane.setAttribute('material', 'shader: flat; transparent: true; side: double');
  plane.setAttribute('look-at', '#rig');

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 152;
  const ctx = canvas.getContext('2d');

  drawRoundedRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 24);
  ctx.fillStyle = 'rgba(20, 28, 28, 0.92)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = borderColor;
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cleanText = (text || '').trim();
  if (cleanText.length <= 28) {
    ctx.fillText(cleanText, canvas.width / 2, canvas.height / 2, canvas.width - 40);
  } else {
    const words = cleanText.split(/\s+/);
    let line1 = '';
    let line2 = '';
    words.forEach(w => {
      if ((line1 + ' ' + w).trim().length <= 28 && !line2) {
        line1 = (line1 + ' ' + w).trim();
      } else {
        line2 = (line2 + ' ' + w).trim();
      }
    });
    if (line2.length > 30) line2 = line2.slice(0, 28) + '…';
    ctx.fillText(line1, canvas.width / 2, canvas.height / 2 - 22, canvas.width - 40);
    ctx.fillText(line2, canvas.width / 2, canvas.height / 2 + 22, canvas.width - 40);
  }

  applyCanvasTexture(plane, canvas);
  return plane;
}

// ========================================================
// 3. PARSER BILINGÜE DOM DE LAS CÉDULAS DE TOUR.JSON
// ========================================================
function cleanNodeText(node) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  // Retirar enlaces/botones de SoundCloud o YouTube que sacan al usuario de VR
  clone.querySelectorAll('[onclick]').forEach(el => el.remove());
  clone.querySelectorAll('img').forEach(el => el.remove());
  clone.innerHTML = clone.innerHTML
    .replace(/<br\s*\/?>/gi, '
')
    .replace(/<\/p>/gi, '

')
    .replace(/<\/div>/gi, '
');

  return clone.textContent
    .replace(/[ 	]+/g, ' ')
    .replace(/
\s*
/g, '

')
    .trim();
}

function parseHotspotContent(htmlContent) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = htmlContent || '';

  const imgEl = wrapper.querySelector('img');
  const imgSrc = imgEl ? imgEl.getAttribute('src') : null;
  const imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';

  // Detectar si tiene columnas bilingües (width: 47%)
  const columns = Array.from(wrapper.querySelectorAll('div')).filter(div => {
    const style = (div.getAttribute('style') || '').toLowerCase();
    return style.includes('width: 47%') || style.includes('width:47%');
  });

  let titleEs = '';
  let titleEn = '';
  let bodyEs = '';
  let bodyEn = '';
  let hasEnglish = false;

  const globalH3 = wrapper.querySelector('h3');
  if (globalH3 && !columns.some(col => col.contains(globalH3))) {
    const rawGlobalTitle = globalH3.textContent.trim();
    if (rawGlobalTitle.includes('/')) {
      const parts = rawGlobalTitle.split('/');
      titleEs = parts[0].trim();
      titleEn = parts.slice(1).join('/').trim();
    } else {
      titleEs = rawGlobalTitle;
      titleEn = rawGlobalTitle;
    }
  }

  if (columns.length >= 2) {
    hasEnglish = true;
    const colEs = columns[0];
    const colEn = columns[1];

    const extractColumn = (col, langMarker) => {
      const children = Array.from(col.children).filter(el => !el.hasAttribute('onclick'));
      let colTitle = '';
      const bodyParts = [];

      children.forEach(child => {
        const txt = cleanNodeText(child);
        if (!txt) return;
        if (txt.toUpperCase() === langMarker) return;
        if (!colTitle && (child.tagName === 'H3' || (child.getAttribute('style') || '').includes('1.3rem'))) {
          colTitle = txt;
        } else {
          bodyParts.push(txt);
        }
      });

      return { colTitle, colBody: bodyParts.join('

').trim() };
    };

    const parsedEs = extractColumn(colEs, 'ESPAÑOL');
    const parsedEn = extractColumn(colEn, 'ENGLISH');

    titleEs = parsedEs.colTitle || titleEs || (imgAlt && imgAlt !== 'Pieza' && imgAlt !== 'Imagen' && imgAlt !== 'Descripción' ? imgAlt : 'Cédula del Museo');
    titleEn = parsedEn.colTitle || titleEn || titleEs;
    bodyEs = parsedEs.colBody;
    bodyEn = parsedEn.colBody;
  } else {
    // Tarjeta de un solo idioma o cartel de solo imagen
    const h3 = wrapper.querySelector('h3');
    if (h3) {
      titleEs = h3.textContent.trim();
      h3.remove();
    }
    const cleaned = cleanNodeText(wrapper);
    bodyEs = cleaned;
  }

  if (!titleEs) {
    if (imgAlt && !['pieza', 'imagen', 'descripción'].includes(imgAlt.toLowerCase())) {
      titleEs = imgAlt;
    } else {
      titleEs = 'Vista de Exposición';
    }
  }
  if (!titleEn) titleEn = titleEs;

  const isPlaceholderCartel =
    titleEs.toLowerCase() === 'cartel informativo' && (!bodyEs || bodyEs.length === 0);
  const imageOnly = Boolean(imgSrc && ((!bodyEs && !bodyEn) || isPlaceholderCartel));

  return {
    titleEs,
    titleEn,
    bodyEs,
    bodyEn,
    hasEnglish: Boolean(hasEnglish && (bodyEn || titleEn)),
    imgSrc,
    imageOnly
  };
}

// ========================================================
// 4. PAGINACIÓN Y DIBUJO DE LA TARJETA 3D EN CANVAS HD
// ========================================================
function wrapTextIntoPages(ctx, text, maxWidth, maxLinesPerPage) {
  if (!text || !text.trim()) return [''];
  const paragraphs = text.split(/
+/);
  const allLines = [];

  paragraphs.forEach((para, pIdx) => {
    const words = para.trim().split(/\s+/);
    let currentLine = '';
    words.forEach(word => {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width > maxWidth && currentLine) {
        allLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    });
    if (currentLine) allLines.push(currentLine);
    if (pIdx < paragraphs.length - 1) allLines.push('');
  });

  const pages = [];
  for (let i = 0; i < allLines.length; i += maxLinesPerPage) {
    pages.push(allLines.slice(i, i + maxLinesPerPage));
  }
  return pages.length > 0 ? pages : [['']];
}

function loadCardImage(url) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return Promise.resolve(imageCache.get(url));

  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imageCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function setInteractiveButton(el, enabled) {
  if (!el) return;
  if (enabled) {
    el.setAttribute('visible', 'true');
    el.classList.add('clickable');
  } else {
    el.setAttribute('visible', 'false');
    el.classList.remove('clickable');
  }
}

function renderActiveCardToCanvas() {
  const planeEl = document.querySelector('#card-canvas-plane');
  const btnLang = document.querySelector('#card-btn-lang');
  const btnPrev = document.querySelector('#card-btn-prev');
  const btnNext = document.querySelector('#card-btn-next');
  const btnClose = document.querySelector('#card-close');

  const canvas = document.createElement('canvas');
  canvas.width = 1240;
  canvas.height = 940;
  const ctx = canvas.getContext('2d');

  // Fondo museográfico con marco dorado
  drawRoundedRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 32);
  ctx.fillStyle = '#2D3A15';
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#D4AF37';
  ctx.stroke();

  const isEn = activeCardState.lang === 'en' && activeCardState.hasEnglish;
  const currentTitle = isEn ? activeCardState.titleEn : activeCardState.titleEs;
  const rawBody = isEn ? activeCardState.bodyEn : activeCardState.bodyEs;

  // Modo 1: Cartel fotográfico de solo imagen (toda el área para la foto)
  if (activeCardState.imageOnly && activeCardState.loadedImage) {
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 38px "Segoe UI", Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(currentTitle, canvas.width / 2, 66, canvas.width - 100);

    const img = activeCardState.loadedImage;
    const boxX = 48;
    const boxY = 100;
    const boxW = canvas.width - 96;
    const boxH = canvas.height - 140;

    const scale = Math.min(boxW / img.width, boxH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const drawX = boxX + (boxW - drawW) / 2;
    const drawY = boxY + (boxH - drawH) / 2;

    ctx.fillStyle = '#141B0B';
    drawRoundedRect(ctx, drawX - 8, drawY - 8, drawW + 16, drawH + 16, 16);
    ctx.fill();
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    setInteractiveButton(btnLang, false);
    setInteractiveButton(btnPrev, false);
    setInteractiveButton(btnNext, false);
    setInteractiveButton(btnClose, true);
    renderButtonPlane(btnClose, '✖ Cerrar', '#7f1d1d', '#D4AF37', '#FFFFFF');

    applyCanvasTexture(planeEl, canvas);
    return;
  }

  // Modo 2: Cédula informativa (con o sin imagen superior)
  let textStartY = 150;
  let maxLinesPerPage = 13;

  if (activeCardState.loadedImage) {
    const img = activeCardState.loadedImage;
    const maxImgW = canvas.width - 120;
    const maxImgH = 340;
    const scale = Math.min(maxImgW / img.width, maxImgH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const drawX = (canvas.width - drawW) / 2;
    const drawY = 36;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 4;
    ctx.strokeRect(drawX, drawY, drawW, drawH);

    textStartY = drawY + drawH + 56;
    maxLinesPerPage = 7;
  } else {
    textStartY = 92;
    maxLinesPerPage = 12;
  }

  // Encabezado e indicador de idioma
  ctx.fillStyle = '#D4AF37';
  ctx.font = 'bold 42px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(currentTitle, 64, textStartY, canvas.width - 320);

  const badgeText = isEn ? 'ENGLISH' : 'ESPAÑOL';
  ctx.font = 'bold 28px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#F5D77F';
  ctx.fillText(badgeText, canvas.width - 64, textStartY);

  // Línea divisoria dorada
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.55)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(64, textStartY + 22);
  ctx.lineTo(canvas.width - 64, textStartY + 22);
  ctx.stroke();

  // Cuerpo de texto paginado
  ctx.font = '34px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillStyle = '#F3F5F0';
  ctx.textAlign = 'left';

  const pages = wrapTextIntoPages(ctx, rawBody, canvas.width - 128, maxLinesPerPage);
  if (activeCardState.pageIndex >= pages.length) {
    activeCardState.pageIndex = pages.length - 1;
  }
  if (activeCardState.pageIndex < 0) {
    activeCardState.pageIndex = 0;
  }

  const lines = pages[activeCardState.pageIndex] || [];
  let lineY = textStartY + 74;
  lines.forEach(line => {
    if (line === '') {
      lineY += 22;
    } else {
      ctx.fillText(line, 64, lineY);
      lineY += 48;
    }
  });

  // Pie de página si hay múltiples páginas
  if (pages.length > 1) {
    ctx.fillStyle = '#D4AF37';
    ctx.font = 'bold 28px "Segoe UI", Roboto, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(
      `Página ${activeCardState.pageIndex + 1} / ${pages.length}`,
      canvas.width - 64,
      canvas.height - 38
    );
  }

  // Configurar botones 3D inferiores según disponibilidad de idioma y páginas
  if (activeCardState.hasEnglish) {
    setInteractiveButton(btnLang, true);
    renderButtonPlane(
      btnLang,
      isEn ? '🌐 Ver Español' : '🌐 View English',
      '#1A2525',
      '#D4AF37',
      '#00d2ff'
    );
  } else {
    setInteractiveButton(btnLang, false);
  }

  if (pages.length > 1) {
    setInteractiveButton(btnPrev, true);
    setInteractiveButton(btnNext, true);
    renderButtonPlane(btnPrev, '▲ Ant.', '#1A2525', '#D4AF37', '#FFFFFF');
    renderButtonPlane(btnNext, '▼ Sig.', '#1A2525', '#D4AF37', '#FFFFFF');
  } else {
    setInteractiveButton(btnPrev, false);
    setInteractiveButton(btnNext, false);
  }

  setInteractiveButton(btnClose, true);
  renderButtonPlane(btnClose, '✖ Cerrar', '#7f1d1d', '#D4AF37', '#FFFFFF');

  applyCanvasTexture(planeEl, canvas);
}

async function openInfoCard(hs) {
  closeMap3D();

  const parsed = parseHotspotContent(hs.text);
  activeCardState = {
    isOpen: true,
    lang: 'es',
    pageIndex: 0,
    pagesEs: [],
    pagesEn: [],
    titleEs: parsed.titleEs,
    titleEn: parsed.titleEn,
    bodyEs: parsed.bodyEs,
    bodyEn: parsed.bodyEn,
    hasEnglish: parsed.hasEnglish,
    imgSrc: parsed.imgSrc,
    loadedImage: null,
    imageOnly: parsed.imageOnly
  };

  const cardWrapper = document.querySelector('#card-wrapper');
  const panelPos = pannellumToCartesian(hs.pitch, hs.yaw, PANEL_RADIUS);
  cardWrapper.setAttribute('position', panelPos);
  cardWrapper.setAttribute('look-at', '#rig');
  cardWrapper.setAttribute('visible', 'true');

  if (parsed.imgSrc) {
    activeCardState.loadedImage = await loadCardImage(parsed.imgSrc);
  }

  renderActiveCardToCanvas();
  cardWrapper.emit('showCard');
}

function closeInfoCard() {
  activeCardState.isOpen = false;
  const cardWrapper = document.querySelector('#card-wrapper');
  if (!cardWrapper) return;

  setInteractiveButton(document.querySelector('#card-btn-lang'), false);
  setInteractiveButton(document.querySelector('#card-btn-prev'), false);
  setInteractiveButton(document.querySelector('#card-btn-next'), false);
  setInteractiveButton(document.querySelector('#card-close'), false);

  cardWrapper.setAttribute('scale', '0 0 0');
  cardWrapper.setAttribute('visible', 'false');
}

// ========================================================
// 5. MAPA 3D INTERACTIVO Y CONSOLA HUD DE MIRADA
// ========================================================
function updateRoomTitleHUD(titleText) {
  const cleanTitle = (titleText || 'Museo de Sitio de Xochicalco').trim();
  const badge2D = document.querySelector('#vr-room-badge');
  if (badge2D) badge2D.textContent = cleanTitle;

  const hudTitlePlane = document.querySelector('#hud-title-plane');
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 168;
  const ctx = canvas.getContext('2d');

  drawRoundedRect(ctx, 6, 6, canvas.width - 12, canvas.height - 12, 24);
  ctx.fillStyle = 'rgba(18, 25, 25, 0.92)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#D4AF37';
  ctx.stroke();

  ctx.fillStyle = '#D4AF37';
  ctx.font = 'bold 26px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SALA ACTUAL (MIRA ABAJO PARA CONTROLES)', canvas.width / 2, 46);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 34px "Segoe UI", Roboto, Arial, sans-serif';
  ctx.fillText(cleanTitle, canvas.width / 2, 110, canvas.width - 48);

  applyCanvasTexture(hudTitlePlane, canvas);
}

function renderHudButtons() {
  renderButtonPlane(
    document.querySelector('#hud-btn-map'),
    '🗺️ Abrir Mapa',
    '#1A2525',
    '#D4AF37',
    '#FFFFFF'
  );
  renderButtonPlane(
    document.querySelector('#hud-btn-edit'),
    gazeMoveMode ? '🔧 Mover: ON' : '🔧 Mover: OFF',
    gazeMoveMode ? '#D4AF37' : '#1A2525',
    '#D4AF37',
    gazeMoveMode ? '#111111' : '#00d2ff'
  );
  renderButtonPlane(
    document.querySelector('#hud-btn-exit'),
    '← Vista Normal',
    '#4A5D23',
    '#D4AF37',
    '#FFFFFF'
  );
}

function buildMap3DPins() {
  const pinsContainer = document.querySelector('#map-3d-pins');
  if (!pinsContainer) return;
  pinsContainer.innerHTML = '';

  const mapHeader = document.querySelector('#map-3d-header');
  renderButtonPlane(
    mapHeader,
    'MAPA DE NAVEGACIÓN — MIRA UN PIN PARA SALTAR DE SALA',
    '#2D3A15',
    '#D4AF37',
    '#D4AF37'
  );

  const mapClose = document.querySelector('#map-3d-close');
  renderButtonPlane(mapClose, '✖ Cerrar Mapa', '#7f1d1d', '#D4AF37', '#FFFFFF');

  const mapW = 3.0;
  const mapH = 1.75;

  MAP_PINS_CONFIG.forEach(pinCfg => {
    const x = ((pinCfg.left / 100) - 0.5) * mapW;
    const y = (0.5 - (pinCfg.top / 100)) * mapH;
    const isCurrent = pinCfg.scenes.includes(currentSceneId);

    const pinSphere = document.createElement('a-sphere');
    pinSphere.setAttribute('position', `${x.toFixed(3)} ${y.toFixed(3)} 0.04`);
    pinSphere.setAttribute('radius', isCurrent ? '0.065' : '0.05');
    pinSphere.setAttribute('color', isCurrent ? '#4A5D23' : '#D4AF37');
    pinSphere.setAttribute(
      'material',
      isCurrent
        ? 'emissive: #4A5D23; emissiveIntensity: 0.9'
        : 'emissive: #D4AF37; emissiveIntensity: 0.6'
    );
    pinSphere.setAttribute('data-scenes', pinCfg.scenes.join(','));
    pinSphere.classList.add('map-pin-3d');

    // Etiqueta emergente al apuntar con la mirada
    const tooltip = createFloatingLabelEntity(
      isCurrent ? `📍 Estás aquí: ${pinCfg.title}` : pinCfg.title,
      isCurrent ? '#00d2ff' : '#D4AF37',
      0.16
    );
    tooltip.setAttribute('scale', '0.55 0.55 0.55');
    tooltip.setAttribute('visible', isCurrent ? 'true' : 'false');
    pinSphere.appendChild(tooltip);

    pinSphere.addEventListener('mouseenter', () => {
      tooltip.setAttribute('visible', 'true');
      pinSphere.setAttribute('scale', '1.35 1.35 1.35');
    });

    pinSphere.addEventListener('mouseleave', () => {
      if (!pinCfg.scenes.includes(currentSceneId)) {
        tooltip.setAttribute('visible', 'false');
      }
      pinSphere.setAttribute('scale', '1 1 1');
    });

    pinSphere.addEventListener('click', () => {
      const targetScene = pinCfg.scenes[0];
      closeMap3D();
      if (targetScene) loadScene(targetScene);
    });

    pinsContainer.appendChild(pinSphere);
  });
}

function openMap3D() {
  closeInfoCard();
  buildMap3DPins();

  const { yaw } = getCameraPitchYaw();
  const mapWrapper = document.querySelector('#map-3d-wrapper');
  const pos = pannellumToCartesian(0, yaw, 2.35);
  mapWrapper.setAttribute('position', pos);
  mapWrapper.setAttribute('look-at', '#rig');
  mapWrapper.setAttribute('visible', 'true');

  document.querySelectorAll('.map-pin-3d').forEach(pin => pin.classList.add('clickable'));
  setInteractiveButton(document.querySelector('#map-3d-close'), true);

  mapWrapper.emit('showMap');
}

function closeMap3D() {
  const mapWrapper = document.querySelector('#map-3d-wrapper');
  if (!mapWrapper) return;

  document.querySelectorAll('.map-pin-3d').forEach(pin => pin.classList.remove('clickable'));
  setInteractiveButton(document.querySelector('#map-3d-close'), false);

  mapWrapper.setAttribute('scale', '0 0 0');
  mapWrapper.setAttribute('visible', 'false');
}

// ========================================================
// 6. MODO MOVER HOTSPOTS CON LA MIRADA (GAZE REPOSITIONING)
// ========================================================
function startGrabHotspotWithGaze(groupEntity, hsData) {
  grabbedHotspot = { entity: groupEntity, hsData };
  const dropBtn = document.querySelector('#gaze-drop-btn');
  setInteractiveButton(dropBtn, true);
  renderButtonPlane(dropBtn, '📌 Soltar Hotspot Aquí', '#D4AF37', '#111111', '#111111');

  if (gazeFollowTick) clearInterval(gazeFollowTick);
  gazeFollowTick = setInterval(() => {
    if (!grabbedHotspot) return;
    const { pitch, yaw } = getCameraPitchYaw();
    grabbedHotspot.hsData.pitch = pitch;
    grabbedHotspot.hsData.yaw = yaw;
    const newPos = pannellumToCartesian(pitch, yaw, HOTSPOT_RADIUS);
    grabbedHotspot.entity.setAttribute('position', newPos);

    const banner = document.querySelector('#gaze-calib-banner');
    if (banner) {
      banner.textContent = `Moviendo Hotspot → "pitch": ${pitch}, "yaw": ${yaw} (Mira el botón inferior "Soltar Hotspot Aquí")`;
    }
    updateRoomTitleHUD(`Pitch: ${pitch}° | Yaw: ${yaw}°`);
  }, 50);
}

function releaseGrabbedHotspot() {
  if (!grabbedHotspot) return;
  if (gazeFollowTick) {
    clearInterval(gazeFollowTick);
    gazeFollowTick = null;
  }

  const { pitch, yaw } = grabbedHotspot.hsData;
  console.log(`%c[Hotspot Actualizado] "pitch": ${pitch}, "yaw": ${yaw}`, 'color: #00d2ff; font-weight: bold;');

  const dropBtn = document.querySelector('#gaze-drop-btn');
  setInteractiveButton(dropBtn, false);
  grabbedHotspot = null;

  const scene = tourData && tourData.scenes ? tourData.scenes[currentSceneId] : null;
  updateRoomTitleHUD(scene ? scene.title : currentSceneId);

  const banner = document.querySelector('#gaze-calib-banner');
  if (banner) {
    banner.textContent = `¡Posición fijada! ("pitch": ${pitch}, "yaw": ${yaw})`;
  }
}

function toggleGazeMoveMode() {
  gazeMoveMode = !gazeMoveMode;
  if (!gazeMoveMode && grabbedHotspot) {
    releaseGrabbedHotspot();
  }
  const banner = document.querySelector('#gaze-calib-banner');
  if (banner) {
    banner.classList.toggle('oculto', !gazeMoveMode);
    if (gazeMoveMode) {
      banner.textContent = 'Modo Mover Hotspot con Mirada ACTIVO — Mira un hotspot para engancharlo';
    }
  }
  renderHudButtons();
}

// ========================================================
// 7. CARGA DE ESCENAS Y GENERACIÓN DE HOTSPOTS 3D
// ========================================================
function setPanoramaTexture(panoramaUrl) {
  const skyEl = document.querySelector('#sky');
  if (!skyEl || !panoramaUrl) return;

  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    panoramaUrl,
    texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      const mesh = skyEl.getObject3D('mesh');
      if (mesh && mesh.material) {
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.map = texture;
        mesh.material.needsUpdate = true;
      } else {
        skyEl.setAttribute('src', panoramaUrl);
      }
    },
    undefined,
    () => {
      skyEl.setAttribute('src', panoramaUrl);
    }
  );
}

function loadScene(sceneId) {
  if (!tourData || !tourData.scenes || !tourData.scenes[sceneId]) return;

  if (grabbedHotspot) releaseGrabbedHotspot();
  closeInfoCard();
  closeMap3D();

  currentSceneId = sceneId;
  const scene = tourData.scenes[sceneId];

  // Actualizar URL sin recargar para mantener sincronía con index.html
  const newUrl = `${window.location.pathname}?scene=${encodeURIComponent(sceneId)}`;
  window.history.replaceState({ scene: sceneId }, document.title, newUrl);

  setPanoramaTexture(scene.panorama);
  updateRoomTitleHUD(scene.title || sceneId);

  const container = document.querySelector('#hotspots-container');
  container.innerHTML = '';

  if (!Array.isArray(scene.hotSpots)) return;

  scene.hotSpots.forEach(hs => {
    const absolutePos = pannellumToCartesian(hs.pitch, hs.yaw, HOTSPOT_RADIUS);
    const group = document.createElement('a-entity');
    group.setAttribute('position', absolutePos);

    if (hs.type === 'scene') {
      const sphere = document.createElement('a-sphere');
      sphere.setAttribute('radius', '0.16');
      sphere.setAttribute('color', '#00d2ff');
      sphere.setAttribute('material', 'emissive: #0077b6; emissiveIntensity: 0.85');
      sphere.classList.add('clickable');
      sphere.setAttribute(
        'animation',
        'property: scale; to: 1.15 1.15 1.15; dir: alternate; loop: true; dur: 950'
      );

      sphere.addEventListener('click', () => {
        if (gazeMoveMode) {
          startGrabHotspotWithGaze(group, hs);
        } else {
          loadScene(hs.sceneId);
        }
      });

      const ring = document.createElement('a-ring');
      ring.setAttribute('radius-inner', '0.20');
      ring.setAttribute('radius-outer', '0.24');
      ring.setAttribute('color', '#00d2ff');
      ring.setAttribute('material', 'emissive: #00d2ff; emissiveIntensity: 0.6; side: double');
      ring.setAttribute('look-at', '#rig');

      const label = createFloatingLabelEntity(hs.text || 'Avanzar', '#00d2ff', 0.38);

      group.appendChild(sphere);
      group.appendChild(ring);
      group.appendChild(label);
      container.appendChild(group);
    } else if (hs.type === 'info') {
      const parsed = parseHotspotContent(hs.text);

      const infoSphere = document.createElement('a-sphere');
      infoSphere.setAttribute('radius', '0.14');
      infoSphere.setAttribute('color', '#D4AF37');
      infoSphere.setAttribute('material', 'emissive: #b5892f; emissiveIntensity: 0.8');
      infoSphere.classList.add('clickable');
      infoSphere.setAttribute(
        'animation',
        'property: position; to: 0 0.05 0; dir: alternate; loop: true; dur: 850'
      );

      infoSphere.addEventListener('click', () => {
        if (gazeMoveMode) {
          startGrabHotspotWithGaze(group, hs);
        } else {
          openInfoCard(hs);
        }
      });

      const label = createFloatingLabelEntity(parsed.titleEs, '#D4AF37', 0.34);

      group.appendChild(infoSphere);
      group.appendChild(label);
      container.appendChild(group);
    }
  });
}

function exitToStandardView() {
  const target = currentSceneId || 'imagen2';
  window.location.href = `index.html?scene=${encodeURIComponent(target)}`;
}

// ========================================================
// 8. INICIALIZACIÓN Y EVENTOS DE INTERACCIÓN POR MIRADA
// ========================================================
document.addEventListener('DOMContentLoaded', () => {
  renderHudButtons();

  // Mantener el dock inferior orientado al giro horizontal de la cámara
  const cameraEl = document.querySelector('#main-camera');
  const hudDock = document.querySelector('#hud-3d-dock');
  if (cameraEl && hudDock) {
    setInterval(() => {
      if (!cameraEl.object3D) return;
      const rotY = cameraEl.getAttribute('rotation');
      if (rotY && typeof rotY.y === 'number') {
        hudDock.setAttribute('rotation', `0 ${rotY.y.toFixed(1)} 0`);
      }
    }, 80);
  }

  // Eventos de los botones de la tarjeta 3D
  document.querySelector('#card-btn-lang').addEventListener('click', () => {
    if (!activeCardState.isOpen || !activeCardState.hasEnglish) return;
    activeCardState.lang = activeCardState.lang === 'es' ? 'en' : 'es';
    activeCardState.pageIndex = 0;
    renderActiveCardToCanvas();
  });

  document.querySelector('#card-btn-prev').addEventListener('click', () => {
    if (!activeCardState.isOpen) return;
    activeCardState.pageIndex = Math.max(0, activeCardState.pageIndex - 1);
    renderActiveCardToCanvas();
  });

  document.querySelector('#card-btn-next').addEventListener('click', () => {
    if (!activeCardState.isOpen) return;
    activeCardState.pageIndex += 1;
    renderActiveCardToCanvas();
  });

  document.querySelector('#card-close').addEventListener('click', closeInfoCard);

  // Eventos de la consola inferior 3D y barra 2D
  document.querySelector('#hud-btn-map').addEventListener('click', openMap3D);
  document.querySelector('#map-btn-2d').addEventListener('click', openMap3D);
  document.querySelector('#map-3d-close').addEventListener('click', closeMap3D);

  document.querySelector('#hud-btn-edit').addEventListener('click', toggleGazeMoveMode);
  document.querySelector('#gaze-drop-btn').addEventListener('click', releaseGrabbedHotspot);

  document.querySelector('#hud-btn-exit').addEventListener('click', exitToStandardView);
  document.querySelector('#exit-btn').addEventListener('click', exitToStandardView);

  // Cargar tour.json e iniciar en la escena solicitada
  const urlParams = new URLSearchParams(window.location.search);
  const requestedScene = urlParams.get('scene');

  fetch(JSON_URL)
    .then(res => res.json())
    .then(data => {
      tourData = data;
      const defaultScene =
        (data.default && data.default.firstScene) || Object.keys(data.scenes)[0];
      const startScene =
        requestedScene && data.scenes[requestedScene] ? requestedScene : defaultScene;
      loadScene(startScene);
    })
    .catch(err => {
      console.error('Error al cargar tour.json en VR:', err);
      updateRoomTitleHUD('Error al cargar tour.json');
    });
});
