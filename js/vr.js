/**
 * ============================================================================
 * MÓDULO WEBXR / A-FRAME — RECORRIDO VIRTUAL XOCHICALCO
 * Experiencia inmersiva 360° optimizada para móvil y visores tipo Cardboard.
 * Control por mirada (Gaze Fuse 1400ms), táctil y ratón.
 * ============================================================================
 */

(function () {
  'use strict';

  // Configuración general
  const JSON_URL = 'tour.json';
  const MAP_IMAGE_URL = 'https://pub-c6d01aa973234af29f7f30a4b35200cf.r2.dev/ASSETS2/110.webp';
  const HOTSPOT_RADIUS = 3.85;
  const PANEL_RADIUS = 2.4;

  // Detección de dispositivo móvil para optimización de VRAM y límites de textura WebGL
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

  /**
   * Adapta las URLs de Cloudflare R2 sin modificar el bucket:
   * 1. Canaliza a través del servicio de imágenes weserv que inyecta encabezados CORS (Access-Control-Allow-Origin: *).
   * 2. En celulares, limita el ancho a máx 4096 px para no superar el límite de hardware (MAX_TEXTURE_SIZE de la GPU).
   */
  function getSafeImageUrl(url, maxWidth = null) {
    if (!url) return '';
    if (url.includes('r2.dev')) {
      const cleanUrl = url.replace(/^https?:\/\//, '');
      let proxied = `https://images.weserv.nl/?url=${encodeURIComponent(cleanUrl)}&output=webp`;
      if (maxWidth) {
        proxied += `&w=${maxWidth}&fit=inside`;
      }
      return proxied;
    }
    return url;
  }

  // Definición exacta de los 12 pines del plano del museo sincronizados con index.html
  const MAP_PINS_CONFIG = [
    { scenes: ['imagen7'], top: 85, left: 20, title: 'Entrada al museo', titleEn: 'Museum Entrance' },
    { scenes: ['imagen8', 'imagen9'], top: 78, left: 18, title: 'Taquilla', titleEn: 'Ticket Office' },
    { scenes: ['imagen10'], top: 63, left: 17, title: 'Sala de introducción', titleEn: 'Introduction Room' },
    { scenes: ['imagen11', 'imagen14', 'imagen15', 'imagen16'], top: 63, left: 44, title: 'Pasillo de las joyas', titleEn: 'Jewels Corridor' },
    { scenes: ['imagen17'], top: 63, left: 70, title: 'Acceso Salas 1, 2 y 3', titleEn: 'Access Rooms 1, 2 & 3' },
    { scenes: ['imagen18', 'imagen19', 'imagen20'], top: 70, left: 76, title: 'Sala 1: Los dones de la Tierra', titleEn: 'Room 1: Gifts of the Earth' },
    { scenes: ['imagen21', 'imagen22', 'imagen23'], top: 63, left: 82, title: 'Sala 2: Hombres guerreros', titleEn: 'Room 2: Warrior Men' },
    { scenes: ['imagen24', 'imagen25', 'imagen26'], top: 57, left: 82, title: 'Sala 3: Resguardo de hombres', titleEn: 'Room 3: Shelter of Men' },
    { scenes: ['imagen27'], top: 54, left: 70, title: 'Pasillo cronológico', titleEn: 'Chronological Corridor' },
    { scenes: ['imagen28'], top: 40, left: 63, title: 'Acceso Salas 4 y 5', titleEn: 'Access Rooms 4 & 5' },
    { scenes: ['imagen32'], top: 50, left: 50, title: 'Sala 4: Manos creadoras', titleEn: 'Room 4: Exquisite Artists' },
    { scenes: ['imagen29', 'imagen30', 'imagen31'], top: 40, left: 50, title: 'Sala 5: Rituales del juego', titleEn: 'Room 5: Ballgame Rituals' }
  ];

  // Estado global de la aplicación
  let tourData = null;
  let currentSceneId = '';
  let isTransitioning = false;
  let gazeMoveMode = false;
  let grabbedHotspot = null;
  let gazeFollowTick = null;
  let toastTimeout = null;

  // Estado de la cédula informativa 3D activa
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
    imageOnly: false,
    hasAudioGuide: false
  };

  // Caches de texturas e imágenes para rendimiento instantáneo
  const imageCache = new Map();
  const textureCache = new Map();

  // ==========================================================================
  // 1. REGISTRO DE COMPONENTES A-FRAME PERSONALIZADOS
  //    (Se ejecutan antes del parseo de etiquetas porque el script está en head)
  // ==========================================================================
  if (typeof AFRAME !== 'undefined') {
    // Orienta cualquier panel directamente hacia la cabeza del usuario (0, 0, 0)
    AFRAME.registerComponent('face-origin', {
      init: function () {
        this.updateRotation();
      },
      updateRotation: function () {
        if (this.el.object3D) {
          this.el.object3D.lookAt(0, 0, 0);
        }
      },
      tick: function () {
        // Solo recalcula cuando la entidad es visible
        if (this.el.object3D && this.el.getAttribute('visible')) {
          this.el.object3D.lookAt(0, 0, 0);
        }
      }
    });

    // Mantiene la consola inferior girando suavemente con el yaw horizontal del usuario
    AFRAME.registerComponent('hud-follow', {
      schema: { lerp: { type: 'number', default: 0.08 } },
      init: function () {
        this.currentYaw = 0;
      },
      tick: function () {
        const cam = document.querySelector('#main-camera');
        if (!cam || !cam.object3D) return;
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.object3D.quaternion);
        const targetYaw = Math.atan2(dir.x, -dir.z) * (180 / Math.PI);
        const diff = ((targetYaw - this.currentYaw + 540) % 360) - 180;
        if (Math.abs(diff) > 1.5) {
          this.currentYaw = (this.currentYaw + diff * this.data.lerp) % 360;
          this.el.setAttribute('rotation', `0 ${this.currentYaw.toFixed(1)} 0`);
        }
      }
    });

    // Control de orden de renderizado en Three.js para evitar parpadeos transparentes
    AFRAME.registerComponent('render-order', {
      schema: { type: 'number', default: 0 },
      init: function () {
        const applyOrder = () => {
          const mesh = this.el.getObject3D('mesh');
          if (mesh) {
            mesh.renderOrder = this.data;
            mesh.traverse(child => {
              if (child.isMesh) child.renderOrder = this.data;
            });
          }
        };
        this.el.addEventListener('object3dset', applyOrder);
        applyOrder();
      }
    });

    // Efecto de atenuación cinematográfica en la esfera de fundido
    AFRAME.registerComponent('screen-fade', {
      schema: { opacity: { type: 'number', default: 1 } },
      init: function () {
        this.setOpacity(this.data.opacity);
      },
      update: function () {
        this.setOpacity(this.data.opacity);
      },
      setOpacity: function (op) {
        const mesh = this.el.getObject3D('mesh');
        if (mesh && mesh.material) {
          mesh.material.transparent = true;
          mesh.material.opacity = Math.max(0, Math.min(1, op));
          mesh.material.needsUpdate = true;
        }
      }
    });
  }

  // ==========================================================================
  // 2. RETROALIMENTACIÓN ACÚSTICA SINTETIZADA (Web Audio API)
  //    Sonidos ligeros, sin dependencias externas ni problemas de CORS
  // ==========================================================================
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playSound(type) {
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'hover') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.05);
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
        osc.start(now);
        osc.stop(now + 0.06);
      } else if (type === 'click') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.08);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
        osc.start(now);
        osc.stop(now + 0.09);
      } else if (type === 'transition') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(261.63, now); // C4
        osc.frequency.exponentialRampToValueAtTime(523.25, now + 0.28);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
        osc.start(now);
        osc.stop(now + 0.32);
      }
    } catch (_) {
      // Si el navegador bloquea audio antes de interactuar, ignora sin romper
    }
  }

  // ==========================================================================
  // 3. MATEMÁTICA ESFÉRICA Y UTILIDADES 3D
  // ==========================================================================
  function pannellumToCartesian(pitch, yaw, radius = HOTSPOT_RADIUS) {
    const radYaw = Number(yaw) * (Math.PI / 180);
    const radPitch = Number(pitch) * (Math.PI / 180);

    const x = radius * Math.cos(radPitch) * Math.sin(radYaw);
    const y = radius * Math.sin(radPitch);
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

  // ==========================================================================
  // 4. GENERADORES DE TEXTURAS 2D HD -> CANVAS THREE.JS
  // ==========================================================================
  function applyCanvasTexture(entityEl, canvas) {
    if (!entityEl) return;
    const applyTex = () => {
      const mesh = entityEl.getObject3D('mesh');
      if (!mesh) return;

      if (mesh.material && mesh.material.map) {
        mesh.material.map.dispose();
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;

      if (mesh.material) {
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

  function renderButtonPlane(planeEl, label, bgColor = '#141B0B', borderColor = '#D4AF37', textColor = '#FFFFFF') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawRoundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 26);
    ctx.fillStyle = bgColor;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = borderColor;
    ctx.stroke();

    // Detalle de brillo superior
    ctx.beginPath();
    ctx.moveTo(24, 18);
    ctx.lineTo(canvas.width - 24, 18);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = textColor;
    ctx.font = 'bold 38px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 + 2, canvas.width - 48);

    applyCanvasTexture(planeEl, canvas);
  }

  function createFloatingLabelEntity(text, borderColor = '#D4AF37', yOffset = 0.32) {
    const plane = document.createElement('a-plane');
    plane.setAttribute('position', `0 ${yOffset} 0`);
    plane.setAttribute('width', '1.35');
    plane.setAttribute('height', '0.34');
    plane.setAttribute('material', 'shader: flat; transparent: true; side: double');
    plane.setAttribute('face-origin', '');

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 160;
    const ctx = canvas.getContext('2d');

    drawRoundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 24);
    ctx.fillStyle = 'rgba(16, 24, 12, 0.94)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = borderColor;
    ctx.stroke();

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 34px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const cleanText = (text || '').trim();
    if (cleanText.length <= 26) {
      ctx.fillText(cleanText, canvas.width / 2, canvas.height / 2, canvas.width - 44);
    } else {
      const words = cleanText.split(/\s+/);
      let line1 = '';
      let line2 = '';
      words.forEach(w => {
        if ((line1 + ' ' + w).trim().length <= 26 && !line2) {
          line1 = (line1 + ' ' + w).trim();
        } else {
          line2 = (line2 + ' ' + w).trim();
        }
      });
      if (line2.length > 28) line2 = line2.slice(0, 26) + '…';
      ctx.fillText(line1, canvas.width / 2, canvas.height / 2 - 22, canvas.width - 44);
      ctx.fillText(line2, canvas.width / 2, canvas.height / 2 + 22, canvas.width - 44);
    }

    applyCanvasTexture(plane, canvas);
    return plane;
  }

  // ==========================================================================
  // 5. PARSER BILINGÜE Y EMPAREJADOR INTELIGENTE DE CÉDULAS
  // ==========================================================================
  function sanitizeMuseumText(str) {
    if (!str) return '';
    return str
      .replace(/Introduccin/g, 'Introducción')
      .replace(/ao/gi, 'año')
      .replace(/aútobuses/gi, 'autobuses')
      .replace(/\uFFFD/g, 'ó');
  }

  function cleanNodeText(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('[onclick]').forEach(el => el.remove());
    clone.querySelectorAll('img').forEach(el => el.remove());

    clone.innerHTML = clone.innerHTML
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n');

    return sanitizeMuseumText(
      clone.textContent
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim()
    );
  }

  function parseHotspotContent(htmlContent) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = htmlContent || '';

    const hasAudioGuide = Boolean(
      (htmlContent || '').toLowerCase().includes('soundcloud') ||
      (htmlContent || '').toLowerCase().includes('audioguía')
    );

    const imgEl = wrapper.querySelector('img');
    const imgSrc = imgEl ? imgEl.getAttribute('src') : null;
    let imgAlt = imgEl ? (imgEl.getAttribute('alt') || '').trim() : '';
    imgAlt = sanitizeMuseumText(imgAlt);

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
      const rawTitle = sanitizeMuseumText(globalH3.textContent.trim());
      if (rawTitle.includes('/')) {
        const parts = rawTitle.split('/');
        titleEs = parts[0].trim();
        titleEn = parts.slice(1).join('/').trim();
      } else {
        titleEs = rawTitle;
        titleEn = rawTitle;
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

        return { colTitle, colBody: bodyParts.join('\n\n').trim() };
      };

      const parsedEs = extractColumn(colEs, 'ESPAÑOL');
      const parsedEn = extractColumn(colEn, 'ENGLISH');

      titleEs = parsedEs.colTitle || titleEs || (imgAlt && !['pieza', 'imagen', 'descripción'].includes(imgAlt.toLowerCase()) ? imgAlt : 'Cédula del Museo');
      titleEn = parsedEn.colTitle || titleEn || titleEs;
      bodyEs = parsedEs.colBody;
      bodyEn = parsedEn.colBody;
    } else {
      const h3 = wrapper.querySelector('h3');
      if (h3) {
        titleEs = sanitizeMuseumText(h3.textContent.trim());
        h3.remove();
      }
      bodyEs = cleanNodeText(wrapper);
    }

    if (!titleEs) {
      if (imgAlt && !['pieza', 'imagen', 'descripción'].includes(imgAlt.toLowerCase())) {
        titleEs = imgAlt;
      } else {
        titleEs = 'Pieza del Museo';
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
      imageOnly,
      hasAudioGuide
    };
  }

  /**
   * Prepara la lista de hotspots de una sala unificando de forma inteligente
   * los pares de esferas (foto + cédula) para que al pulsar cualquiera de ellas
   * el visitante acceda a la cédula completa con foto y texto bilingüe.
   */
  function buildUnifiedHotspots(rawHotspots) {
    if (!Array.isArray(rawHotspots)) return [];

    const infos = [];
    const scenes = [];

    rawHotspots.forEach((hs, idx) => {
      if (hs.type === 'scene') {
        scenes.push({ ...hs, originalIndex: idx });
      } else if (hs.type === 'info') {
        const parsed = parseHotspotContent(hs.text);
        infos.push({
          ...hs,
          originalIndex: idx,
          parsed,
          isImgOnly: Boolean(parsed.imgSrc && !parsed.bodyEs),
          isTextOnly: Boolean(!parsed.imgSrc && parsed.bodyEs)
        });
      }
    });

    // Enlazar pares cercanos imagen-texto (mismo artefacto)
    const used = new Set();
    infos.forEach((itemA, i) => {
      if (used.has(i)) return;
      if (!itemA.isImgOnly && !itemA.isTextOnly) return;

      let bestMatch = null;
      let minDistance = 999;

      infos.forEach((itemB, j) => {
        if (i === j || used.has(j)) return;
        const compatible =
          (itemA.isImgOnly && itemB.isTextOnly) ||
          (itemA.isTextOnly && itemB.isImgOnly);
        if (!compatible) return;

        const dy = Math.abs(((itemA.yaw - itemB.yaw + 540) % 360) - 180);
        const dp = Math.abs(itemA.pitch - itemB.pitch);
        const distance = Math.hypot(dy, dp);

        if (dy <= 4.0 && dp <= 18.0 && distance < minDistance) {
          minDistance = distance;
          bestMatch = { item: itemB, index: j };
        }
      });

      if (bestMatch) {
        used.add(i);
        used.add(bestMatch.index);
        const imgItem = itemA.isImgOnly ? itemA : bestMatch.item;
        const txtItem = itemA.isTextOnly ? itemA : bestMatch.item;

        // Compartir el contenido entre ambos para que ninguno quede huérfano
        const mergedContent = {
          titleEs: txtItem.parsed.titleEs || imgItem.parsed.titleEs,
          titleEn: txtItem.parsed.titleEn || imgItem.parsed.titleEn,
          bodyEs: txtItem.parsed.bodyEs,
          bodyEn: txtItem.parsed.bodyEn,
          hasEnglish: txtItem.parsed.hasEnglish,
          imgSrc: imgItem.parsed.imgSrc,
          imageOnly: false,
          hasAudioGuide: txtItem.parsed.hasAudioGuide || imgItem.parsed.hasAudioGuide
        };

        imgItem.parsed = mergedContent;
        txtItem.parsed = mergedContent;
      }
    });

    return [...scenes, ...infos];
  }

  // ==========================================================================
  // 6. PAGINACIÓN Y TARJETA 3D EN CANVAS HD (Proporción 16:10 / 1600x1000)
  // ==========================================================================
  function wrapTextIntoPages(ctx, text, maxWidth, maxLinesPerPage) {
    if (!text || !text.trim()) return [['']];
    const paragraphs = text.split(/\n+/);
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

    const safeUrl = getSafeImageUrl(url, isMobile ? 800 : 1200);

    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        imageCache.set(url, img);
        resolve(img);
      };
      img.onerror = () => {
        // Fallback: si falla por alguna razón, probar proxy alternativo o directo
        console.warn('Reintentando carga de imagen de cédula:', url);
        const retryImg = new Image();
        retryImg.crossOrigin = 'anonymous';
        retryImg.onload = () => {
          imageCache.set(url, retryImg);
          resolve(retryImg);
        };
        retryImg.onerror = () => resolve(null);
        retryImg.src = `https://corsproxy.io/?${encodeURIComponent(url)}`;
      };
      img.src = safeUrl;
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
    canvas.width = 1600;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');

    // Fondo museográfico con degradado verde selva oscuro y marco dorado doble
    const bgGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGrad.addColorStop(0, '#1c2813');
    bgGrad.addColorStop(1, '#0e150a');

    drawRoundedRect(ctx, 12, 12, canvas.width - 24, canvas.height - 24, 34);
    ctx.fillStyle = bgGrad;
    ctx.fill();

    // Marco exterior dorado
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#D4AF37';
    ctx.stroke();

    // Filete interior dorado fino
    drawRoundedRect(ctx, 24, 24, canvas.width - 48, canvas.height - 48, 24);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.45)';
    ctx.stroke();

    // Motivos ornamentales en las cuatro esquinas
    const cornerSize = 18;
    ctx.fillStyle = '#D4AF37';
    [[32, 32], [canvas.width - 32 - cornerSize, 32], [32, canvas.height - 32 - cornerSize], [canvas.width - 32 - cornerSize, canvas.height - 32 - cornerSize]].forEach(([cx, cy]) => {
      ctx.fillRect(cx, cy, cornerSize, cornerSize);
    });

    // Franja superior de identidad del museo
    ctx.font = 'bold 22px Georgia, serif';
    ctx.fillStyle = '#D4AF37';
    ctx.textAlign = 'left';
    ctx.fillText('MUSEO DE SITIO DE XOCHICALCO', 54, 62);

    const isEn = activeCardState.lang === 'en' && activeCardState.hasEnglish;
    const currentTitle = (isEn ? activeCardState.titleEn : activeCardState.titleEs) || 'Cédula de Exposición';
    const rawBody = (isEn ? activeCardState.bodyEn : activeCardState.bodyEs) || '';

    // Insignia de idioma a la derecha
    const langBadgeText = isEn ? 'ENGLISH · CÉDULA' : 'ESPAÑOL · CÉDULA';
    ctx.font = 'bold 22px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#F5D77F';
    ctx.fillText(langBadgeText, canvas.width - 54, 62);

    // Línea divisoria dorada
    ctx.beginPath();
    ctx.moveTo(54, 82);
    ctx.lineTo(canvas.width - 54, 82);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(212, 175, 55, 0.55)';
    ctx.stroke();

    // MODO A: Cartel fotográfico puro (sin cuerpo de texto)
    if (activeCardState.imageOnly && activeCardState.loadedImage) {
      ctx.font = 'bold 44px Georgia, serif';
      ctx.fillStyle = '#F5D77F';
      ctx.textAlign = 'center';
      ctx.fillText(currentTitle, canvas.width / 2, 140, canvas.width - 120);

      const img = activeCardState.loadedImage;
      const boxX = 64;
      const boxY = 175;
      const boxW = canvas.width - 128;
      const boxH = canvas.height - 235;

      const scale = Math.min(boxW / img.width, boxH / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const drawX = boxX + (boxW - drawW) / 2;
      const drawY = boxY + (boxH - drawH) / 2;

      ctx.fillStyle = '#0a0d07';
      drawRoundedRect(ctx, drawX - 8, drawY - 8, drawW + 16, drawH + 16, 16);
      ctx.fill();
      ctx.drawImage(img, drawX, drawY, drawW, drawH);

      ctx.strokeStyle = '#D4AF37';
      ctx.lineWidth = 4;
      ctx.stroke();

      setInteractiveButton(btnLang, false);
      setInteractiveButton(btnPrev, false);
      setInteractiveButton(btnNext, false);
      setInteractiveButton(btnClose, true);
      renderButtonPlane(btnClose, '✖ Cerrar', '#7f1d1d', '#D4AF37', '#FFFFFF');

      applyCanvasTexture(planeEl, canvas);
      return;
    }

    // MODO B: Cédula completa con foto a la izquierda y texto a la derecha
    if (activeCardState.loadedImage && rawBody) {
      const img = activeCardState.loadedImage;
      const colImgW = 600;
      const colImgH = 740;
      const colImgX = 64;
      const colImgY = 130;

      const scale = Math.min(colImgW / img.width, colImgH / img.height);
      const drawW = img.width * scale;
      const drawH = img.height * scale;
      const drawX = colImgX + (colImgW - drawW) / 2;
      const drawY = colImgY + (colImgH - drawH) / 2;

      // Marco para la pieza
      ctx.fillStyle = '#0b0f08';
      drawRoundedRect(ctx, drawX - 10, drawY - 10, drawW + 20, drawH + 20, 18);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#D4AF37';
      ctx.stroke();

      ctx.drawImage(img, drawX, drawY, drawW, drawH);

      // Columna de texto a la derecha
      const textX = 700;
      const textW = canvas.width - textX - 64;

      ctx.font = 'bold 42px Georgia, serif';
      ctx.fillStyle = '#F5D77F';
      ctx.textAlign = 'left';
      ctx.fillText(currentTitle, textX, 155, textW);

      if (activeCardState.hasAudioGuide) {
        ctx.font = 'italic bold 22px "Segoe UI", sans-serif';
        ctx.fillStyle = '#00d2ff';
        ctx.fillText('🎧 Audioguía oficial disponible', textX, 195);
      }

      ctx.font = '31px "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#F3F5F0';

      const startY = activeCardState.hasAudioGuide ? 245 : 220;
      const maxLines = 14;
      const pages = wrapTextIntoPages(ctx, rawBody, textW, maxLines);

      if (activeCardState.pageIndex >= pages.length) activeCardState.pageIndex = pages.length - 1;
      if (activeCardState.pageIndex < 0) activeCardState.pageIndex = 0;

      const lines = pages[activeCardState.pageIndex] || [];
      let lineY = startY;
      lines.forEach(line => {
        if (line === '') {
          lineY += 18;
        } else {
          ctx.fillText(line, textX, lineY);
          lineY += 44;
        }
      });

      if (pages.length > 1) {
        ctx.font = 'bold 24px "Segoe UI", sans-serif';
        ctx.fillStyle = '#D4AF37';
        ctx.textAlign = 'right';
        ctx.fillText(
          `Página ${activeCardState.pageIndex + 1} de ${pages.length}`,
          canvas.width - 64,
          canvas.height - 48
        );
      }

      configCardButtons(btnLang, btnPrev, btnNext, btnClose, isEn, pages.length);
      applyCanvasTexture(planeEl, canvas);
      return;
    }

    // MODO C: Cédula solo texto a ancho completo
    ctx.font = 'bold 46px Georgia, serif';
    ctx.fillStyle = '#F5D77F';
    ctx.textAlign = 'left';
    ctx.fillText(currentTitle, 64, 155, canvas.width - 128);

    ctx.font = '33px "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#F3F5F0';

    const pages = wrapTextIntoPages(ctx, rawBody, canvas.width - 128, 14);
    if (activeCardState.pageIndex >= pages.length) activeCardState.pageIndex = pages.length - 1;
    if (activeCardState.pageIndex < 0) activeCardState.pageIndex = 0;

    const lines = pages[activeCardState.pageIndex] || [];
    let lineY = 225;
    lines.forEach(line => {
      if (line === '') {
        lineY += 20;
      } else {
        ctx.fillText(line, 64, lineY);
        lineY += 46;
      }
    });

    if (pages.length > 1) {
      ctx.font = 'bold 26px "Segoe UI", sans-serif';
      ctx.fillStyle = '#D4AF37';
      ctx.textAlign = 'right';
      ctx.fillText(
        `Página ${activeCardState.pageIndex + 1} de ${pages.length}`,
        canvas.width - 64,
        canvas.height - 48
      );
    }

    configCardButtons(btnLang, btnPrev, btnNext, btnClose, isEn, pages.length);
    applyCanvasTexture(planeEl, canvas);
  }

  function configCardButtons(btnLang, btnPrev, btnNext, btnClose, isEn, totalPages) {
    if (activeCardState.hasEnglish) {
      setInteractiveButton(btnLang, true);
      renderButtonPlane(
        btnLang,
        isEn ? '🌐 Ver Español' : '🌐 View English',
        '#141B0B',
        '#D4AF37',
        '#00d2ff'
      );
    } else {
      setInteractiveButton(btnLang, false);
    }

    if (totalPages > 1) {
      setInteractiveButton(btnPrev, true);
      setInteractiveButton(btnNext, true);
      renderButtonPlane(btnPrev, '◀ Ant.', '#141B0B', '#D4AF37', '#FFFFFF');
      renderButtonPlane(btnNext, 'Sig. ▶', '#141B0B', '#D4AF37', '#FFFFFF');
    } else {
      setInteractiveButton(btnPrev, false);
      setInteractiveButton(btnNext, false);
    }

    setInteractiveButton(btnClose, true);
    renderButtonPlane(btnClose, '✖ Cerrar', '#7f1d1d', '#D4AF37', '#FFFFFF');
  }

  async function openInfoCard(hsData) {
    playSound('click');
    closeMap3D();

    const parsed = hsData.parsed || parseHotspotContent(hsData.text);
    activeCardState = {
      isOpen: true,
      lang: 'es',
      pageIndex: 0,
      titleEs: parsed.titleEs,
      titleEn: parsed.titleEn,
      bodyEs: parsed.bodyEs,
      bodyEn: parsed.bodyEn,
      hasEnglish: parsed.hasEnglish,
      imgSrc: parsed.imgSrc,
      loadedImage: null,
      imageOnly: parsed.imageOnly,
      hasAudioGuide: parsed.hasAudioGuide
    };

    const cardWrapper = document.querySelector('#card-wrapper');
    const panelPos = pannellumToCartesian(hsData.pitch, hsData.yaw, PANEL_RADIUS);
    cardWrapper.setAttribute('position', panelPos);
    cardWrapper.setAttribute('visible', 'true');

    if (parsed.imgSrc) {
      activeCardState.loadedImage = await loadCardImage(parsed.imgSrc);
    }

    renderActiveCardToCanvas();
    cardWrapper.emit('showCard');
  }

  function closeInfoCard() {
    if (!activeCardState.isOpen) return;
    playSound('click');
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

  // ==========================================================================
  // 7. RÓTULO 3D FLOTANTE DE BIENVENIDA A CADA SALA (Room Toast)
  // ==========================================================================
  function showRoomToast(titleEs, titleEn) {
    const toastEl = document.querySelector('#room-toast');
    if (!toastEl) return;

    const { yaw } = getCameraPitchYaw();
    const pos = pannellumToCartesian(8, yaw, 3.2);
    toastEl.setAttribute('position', pos);

    const canvas = document.createElement('canvas');
    canvas.width = 1120;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');

    drawRoundedRect(ctx, 10, 10, canvas.width - 20, canvas.height - 20, 28);
    ctx.fillStyle = 'rgba(16, 25, 12, 0.94)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#D4AF37';
    ctx.stroke();

    ctx.font = 'bold 22px "Segoe UI", sans-serif';
    ctx.fillStyle = '#D4AF37';
    ctx.textAlign = 'center';
    ctx.fillText('SALA ACTUAL · CURRENT ROOM', canvas.width / 2, 54);

    ctx.font = 'bold 42px Georgia, serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(titleEs, canvas.width / 2, 114, canvas.width - 64);

    if (titleEn && titleEn !== titleEs) {
      ctx.font = 'italic 28px Georgia, serif';
      ctx.fillStyle = '#F5D77F';
      ctx.fillText(titleEn, canvas.width / 2, 168, canvas.width - 64);
    }

    applyCanvasTexture(toastEl, canvas);
    toastEl.setAttribute('visible', 'true');
    toastEl.setAttribute('material', 'opacity', 1);

    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      let op = 1;
      const fadeStep = () => {
        op -= 0.08;
        if (op <= 0) {
          toastEl.setAttribute('visible', 'false');
        } else {
          toastEl.setAttribute('material', 'opacity', op);
          requestAnimationFrame(fadeStep);
        }
      };
      fadeStep();
    }, 3200);
  }

  // ==========================================================================
  // 8. MAPA 3D INTERACTIVO POR MIRADA
  // ==========================================================================
  let mapImageTextureLoaded = false;

  function ensureMapImageLoaded() {
    if (mapImageTextureLoaded) return;
    const mapImagePlane = document.querySelector('#map-3d-image');
    if (!mapImagePlane) return;

    const safeMapUrl = getSafeImageUrl(MAP_IMAGE_URL, isMobile ? 1200 : 2048);
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      safeMapUrl,
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        const mesh = mapImagePlane.getObject3D('mesh');
        if (mesh && mesh.material) {
          mesh.material.map = tex;
          mesh.material.transparent = true;
          mesh.material.needsUpdate = true;
        }
        mapImageTextureLoaded = true;
      },
      undefined,
      err => {
        console.warn('Aviso: reintentando plano del mapa con proxy alternativo', err);
        loader.load(
          `https://corsproxy.io/?${encodeURIComponent(MAP_IMAGE_URL)}`,
          fallbackTex => {
            fallbackTex.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
            fallbackTex.minFilter = THREE.LinearFilter;
            fallbackTex.magFilter = THREE.LinearFilter;
            fallbackTex.generateMipmaps = false;
            const mesh = mapImagePlane.getObject3D('mesh');
            if (mesh && mesh.material) {
              mesh.material.map = fallbackTex;
              mesh.material.transparent = true;
              mesh.material.needsUpdate = true;
            }
            mapImageTextureLoaded = true;
          }
        );
      }
    );
  }

  function buildMap3DPins() {
    const pinsContainer = document.querySelector('#map-3d-pins');
    if (!pinsContainer) return;
    pinsContainer.innerHTML = '';

    const mapHeader = document.querySelector('#map-3d-header');
    renderButtonPlane(
      mapHeader,
      'MAPA DEL MUSEO — MIRA UN PIN PARA SALTAR DE SALA',
      '#1C2612',
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
      pinSphere.setAttribute('position', `${x.toFixed(3)} ${y.toFixed(3)} 0.05`);
      pinSphere.setAttribute('radius', isCurrent ? '0.075' : '0.055');
      pinSphere.setAttribute('color', isCurrent ? '#00d2ff' : '#D4AF37');
      pinSphere.setAttribute(
        'material',
        isCurrent
          ? 'emissive: #0077b6; emissiveIntensity: 0.95'
          : 'emissive: #94711f; emissiveIntensity: 0.7'
      );
      pinSphere.classList.add('clickable');

      // Anillo decorativo en el pin
      const ring = document.createElement('a-ring');
      ring.setAttribute('radius-inner', isCurrent ? '0.085' : '0.065');
      ring.setAttribute('radius-outer', isCurrent ? '0.105' : '0.08');
      ring.setAttribute('color', isCurrent ? '#00d2ff' : '#D4AF37');
      ring.setAttribute('material', 'shader: flat; side: double; transparent: true; opacity: 0.85');
      ring.setAttribute('position', '0 0 0.01');
      pinSphere.appendChild(ring);

      // Tooltip flotante con título
      const labelText = isCurrent ? `📍 Estás aquí: ${pinCfg.title}` : pinCfg.title;
      const tooltip = createFloatingLabelEntity(labelText, isCurrent ? '#00d2ff' : '#D4AF37', 0.18);
      tooltip.setAttribute('scale', '0.55 0.55 0.55');
      tooltip.setAttribute('visible', isCurrent ? 'true' : 'false');
      pinSphere.appendChild(tooltip);

      pinSphere.addEventListener('mouseenter', () => {
        playSound('hover');
        tooltip.setAttribute('visible', 'true');
        pinSphere.setAttribute('scale', '1.3 1.3 1.3');
      });

      pinSphere.addEventListener('mouseleave', () => {
        if (!pinCfg.scenes.includes(currentSceneId)) {
          tooltip.setAttribute('visible', 'false');
        }
        pinSphere.setAttribute('scale', '1 1 1');
      });

      pinSphere.addEventListener('click', () => {
        playSound('click');
        const target = pinCfg.scenes[0];
        closeMap3D();
        if (target) loadScene(target);
      });

      pinsContainer.appendChild(pinSphere);
    });
  }

  function openMap3D() {
    playSound('click');
    closeInfoCard();
    ensureMapImageLoaded();
    buildMap3DPins();

    const { yaw } = getCameraPitchYaw();
    const mapWrapper = document.querySelector('#map-3d-wrapper');
    const pos = pannellumToCartesian(0, yaw, 2.35);
    mapWrapper.setAttribute('position', pos);
    mapWrapper.setAttribute('visible', 'true');

    setInteractiveButton(document.querySelector('#map-3d-close'), true);
    mapWrapper.emit('showMap');
  }

  function closeMap3D() {
    const mapWrapper = document.querySelector('#map-3d-wrapper');
    if (!mapWrapper) return;
    setInteractiveButton(document.querySelector('#map-3d-close'), false);
    mapWrapper.setAttribute('scale', '0 0 0');
    mapWrapper.setAttribute('visible', 'false');
  }

  // ==========================================================================
  // 9. CONSOLA INFERIOR 3D (HUD A LOS PIES DEL VISITANTE)
  // ==========================================================================
  function updateRoomTitleHUD(fullTitle) {
    const clean = sanitizeMuseumText(fullTitle || 'Museo de Sitio de Xochicalco');
    let titleEs = clean;
    let titleEn = '';

    if (clean.includes('/')) {
      const parts = clean.split('/');
      titleEs = parts[0].trim();
      titleEn = parts.slice(1).join('/').trim();
    }

    // Actualizar barra 2D
    const badgeEs = document.querySelector('#vr-room-es');
    const badgeEn = document.querySelector('#vr-room-en');
    if (badgeEs) badgeEs.textContent = titleEs;
    if (badgeEn) {
      if (titleEn && titleEn !== titleEs) {
        badgeEn.textContent = titleEn;
        badgeEn.classList.remove('oculto');
      } else {
        badgeEn.classList.add('oculto');
      }
    }

    // Actualizar placa 3D en la consola
    const hudTitlePlane = document.querySelector('#hud-title-plane');
    if (hudTitlePlane) {
      const canvas = document.createElement('canvas');
      canvas.width = 1040;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');

      drawRoundedRect(ctx, 8, 8, canvas.width - 16, canvas.height - 16, 26);
      ctx.fillStyle = 'rgba(18, 26, 14, 0.94)';
      ctx.fill();
      ctx.lineWidth = 6;
      ctx.strokeStyle = '#D4AF37';
      ctx.stroke();

      ctx.fillStyle = '#D4AF37';
      ctx.font = 'bold 24px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SALA ACTUAL · MIRA ABAJO PARA NAVEGACIÓN', canvas.width / 2, 48);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 36px Georgia, serif';
      ctx.fillText(titleEs, canvas.width / 2, 108, canvas.width - 64);

      if (titleEn && titleEn !== titleEs) {
        ctx.fillStyle = '#F5D77F';
        ctx.font = 'italic 24px Georgia, serif';
        ctx.fillText(titleEn, canvas.width / 2, 154, canvas.width - 64);
      }

      applyCanvasTexture(hudTitlePlane, canvas);
    }

    showRoomToast(titleEs, titleEn);
  }

  function renderHudButtons() {
    renderButtonPlane(
      document.querySelector('#hud-btn-map'),
      '🗺️ Abrir Mapa',
      '#141B0B',
      '#D4AF37',
      '#FFFFFF'
    );
    renderButtonPlane(
      document.querySelector('#hud-btn-edit'),
      gazeMoveMode ? '🔧 Mover: ON' : '🔧 Mover: OFF',
      gazeMoveMode ? '#D4AF37' : '#141B0B',
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

  // ==========================================================================
  // 10. MODO CALIBRACIÓN (MOVER HOTSPOTS CON LA MIRADA)
  // ==========================================================================
  function startGrabHotspotWithGaze(groupEntity, hsData) {
    playSound('click');
    grabbedHotspot = { entity: groupEntity, hsData };
    const dropBtn = document.querySelector('#gaze-drop-btn');
    setInteractiveButton(dropBtn, true);
    renderButtonPlane(dropBtn, '📌 Soltar Aquí', '#D4AF37', '#111111', '#111111');

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
        banner.textContent = `Moviendo → "pitch": ${pitch}, "yaw": ${yaw} (Mira el botón "Soltar Aquí")`;
      }
    }, 50);
  }

  function releaseGrabbedHotspot() {
    if (!grabbedHotspot) return;
    playSound('click');
    if (gazeFollowTick) {
      clearInterval(gazeFollowTick);
      gazeFollowTick = null;
    }

    const { pitch, yaw } = grabbedHotspot.hsData;
    console.log(`%c[Hotspot Ajustado] "pitch": ${pitch}, "yaw": ${yaw}`, 'color: #00d2ff; font-weight: bold;');

    const dropBtn = document.querySelector('#gaze-drop-btn');
    setInteractiveButton(dropBtn, false);
    grabbedHotspot = null;

    const banner = document.querySelector('#gaze-calib-banner');
    if (banner) {
      banner.textContent = `¡Posición guardada! ("pitch": ${pitch}, "yaw": ${yaw})`;
    }
  }

  function toggleGazeMoveMode() {
    playSound('click');
    gazeMoveMode = !gazeMoveMode;
    if (!gazeMoveMode && grabbedHotspot) {
      releaseGrabbedHotspot();
    }
    const banner = document.querySelector('#gaze-calib-banner');
    if (banner) {
      banner.classList.toggle('oculto', !gazeMoveMode);
      if (gazeMoveMode) {
        banner.textContent = 'Modo Mover Hotspot ACTIVO — Mira un hotspot para engancharlo';
      }
    }
    renderHudButtons();
  }

  // ==========================================================================
  // 11. GESTOR DE ESCENAS, PANORAMAS Y TRANSICIONES CINEMATOGRÁFICAS
  // ==========================================================================
  function loadPanoramaTexture(url) {
    if (textureCache.has(url)) {
      return Promise.resolve(textureCache.get(url));
    }

    // En móviles limitamos el ancho a 4096 px para garantizar que no exceda el MAX_TEXTURE_SIZE de la GPU
    const safePanoramaUrl = getSafeImageUrl(url, isMobile ? 4096 : 8192);

    return new Promise((resolve, reject) => {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin('anonymous');
      loader.load(
        safePanoramaUrl,
        texture => {
          texture.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
          texture.minFilter = THREE.LinearFilter;
          texture.magFilter = THREE.LinearFilter;
          texture.generateMipmaps = false;
          textureCache.set(url, texture);
          resolve(texture);
        },
        undefined,
        err => {
          console.warn('Aviso: reintentando panorama con proxy alternativo:', url);
          loader.load(
            `https://corsproxy.io/?${encodeURIComponent(url)}`,
            texture2 => {
              texture2.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
              texture2.minFilter = THREE.LinearFilter;
              texture2.magFilter = THREE.LinearFilter;
              texture2.generateMipmaps = false;
              textureCache.set(url, texture2);
              resolve(texture2);
            },
            undefined,
            err2 => {
              // Último intento: intentar cargar directo
              loader.load(
                url,
                textureDirect => {
                  textureDirect.colorSpace = THREE.SRGBColorSpace || THREE.sRGBEncoding;
                  textureDirect.minFilter = THREE.LinearFilter;
                  textureDirect.magFilter = THREE.LinearFilter;
                  textureDirect.generateMipmaps = false;
                  textureCache.set(url, textureDirect);
                  resolve(textureDirect);
                },
                undefined,
                err3 => reject(err3)
              );
            }
          );
        }
      );
    });
  }

  function applyPanoramaToSky(texture) {
    const skyEl = document.querySelector('#sky');
    if (!skyEl) return;
    const mesh = skyEl.getObject3D('mesh');
    if (mesh && mesh.material) {
      mesh.material.map = texture;
      mesh.material.needsUpdate = true;
    } else {
      skyEl.addEventListener(
        'loaded',
        () => {
          const m = skyEl.getObject3D('mesh');
          if (m && m.material) {
            m.material.map = texture;
            m.material.needsUpdate = true;
          }
        },
        { once: true }
      );
    }
  }

  function setFadeSphereOpacity(targetOpacity, durationMs) {
    const fadeSphere = document.querySelector('#fade-sphere');
    if (!fadeSphere) return Promise.resolve();

    return new Promise(resolve => {
      const startOp = Number(fadeSphere.getAttribute('screen-fade')?.opacity ?? 1);
      const startTime = performance.now();

      const animate = now => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / durationMs);
        const current = startOp + (targetOpacity - startOp) * progress;
        fadeSphere.setAttribute('screen-fade', `opacity: ${current}`);

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(animate);
    });
  }

  function showLoadingHud(show, labelText = 'Cargando sala……') {
    const hud = document.querySelector('#loading-hud');
    const labelPlane = document.querySelector('#loading-label');
    if (!hud) return;

    if (show) {
      if (labelPlane) {
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        drawRoundedRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 20);
        ctx.fillStyle = 'rgba(16, 24, 12, 0.9)';
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#D4AF37';
        ctx.stroke();

        ctx.font = 'bold 32px "Segoe UI", sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, canvas.width / 2, canvas.height / 2);
        applyCanvasTexture(labelPlane, canvas);
      }
      hud.setAttribute('visible', 'true');
    } else {
      hud.setAttribute('visible', 'false');
    }
  }

  function preloadAdjacentScenes(sceneData) {
    // En móviles desactivamos la precarga masiva para proteger la VRAM de la GPU
    if (isMobile) return;
    if (!sceneData || !Array.isArray(sceneData.hotSpots)) return;
    sceneData.hotSpots.forEach(hs => {
      if (hs.type === 'scene' && hs.sceneId && tourData.scenes[hs.sceneId]) {
        const nextUrl = tourData.scenes[hs.sceneId].panorama;
        if (nextUrl && !textureCache.has(nextUrl)) {
          const safeNextUrl = getSafeImageUrl(nextUrl, 8192);
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = safeNextUrl;
        }
      }
    });
  }

  async function loadScene(sceneId) {
    if (!tourData || !tourData.scenes || !tourData.scenes[sceneId]) return;
    if (isTransitioning) return;
    isTransitioning = true;

    playSound('transition');
    if (grabbedHotspot) releaseGrabbedHotspot();
    closeInfoCard();
    closeMap3D();

    const scene = tourData.scenes[sceneId];
    currentSceneId = sceneId;

    // Actualizar URL sin recargar para sincronización perfecta con index.html
    const newUrl = `${window.location.pathname}?scene=${encodeURIComponent(sceneId)}`;
    window.history.replaceState({ scene: sceneId }, document.title, newUrl);

    // 1. Mostrar pantalla oscura y spinner
    showLoadingHud(true, 'Cargando sala……');
    await setFadeSphereOpacity(1, 260);

    try {
      // 2. Descargar o recuperar del cache la textura equirectangular
      const texture = await loadPanoramaTexture(scene.panorama);
      applyPanoramaToSky(texture);

      // 3. Generar los hotspots unificados en 3D
      const container = document.querySelector('#hotspots-container');
      container.innerHTML = '';

      const unifiedHotspots = buildUnifiedHotspots(scene.hotSpots);
      unifiedHotspots.forEach(hs => {
        const absolutePos = pannellumToCartesian(hs.pitch, hs.yaw, HOTSPOT_RADIUS);
        const group = document.createElement('a-entity');
        group.setAttribute('position', absolutePos);

        if (hs.type === 'scene') {
          // ESFERA DE PORTAL / TELETRANSPORTE (CIAN)
          const sphere = document.createElement('a-sphere');
          sphere.setAttribute('radius', '0.16');
          sphere.setAttribute('color', '#00d2ff');
          sphere.setAttribute('material', 'emissive: #0077b6; emissiveIntensity: 0.95');
          sphere.classList.add('clickable');
          sphere.setAttribute(
            'animation',
            'property: scale; to: 1.18 1.18 1.18; dir: alternate; loop: true; dur: 950; easing: easeInOutSine'
          );

          sphere.addEventListener('mouseenter', () => playSound('hover'));
          sphere.addEventListener('click', () => {
            if (gazeMoveMode) {
              startGrabHotspotWithGaze(group, hs);
            } else {
              loadScene(hs.sceneId);
            }
          });

          // Anillo orbital exterior
          const ring = document.createElement('a-ring');
          ring.setAttribute('radius-inner', '0.21');
          ring.setAttribute('radius-outer', '0.25');
          ring.setAttribute('color', '#00d2ff');
          ring.setAttribute('material', 'emissive: #00d2ff; emissiveIntensity: 0.7; side: double');
          ring.setAttribute('face-origin', '');
          ring.setAttribute(
            'animation',
            'property: rotation; to: 0 0 360; loop: true; dur: 8000; easing: linear'
          );

          const label = createFloatingLabelEntity(hs.text || 'Avanzar', '#00d2ff', 0.38);

          group.appendChild(sphere);
          group.appendChild(ring);
          group.appendChild(label);
          container.appendChild(group);
        } else if (hs.type === 'info') {
          // ESFERA DE CÉDULA / ARTEFACTO (DORADO)
          const infoSphere = document.createElement('a-sphere');
          infoSphere.setAttribute('radius', '0.14');
          infoSphere.setAttribute('color', '#D4AF37');
          infoSphere.setAttribute('material', 'emissive: #b5892f; emissiveIntensity: 0.9');
          infoSphere.classList.add('clickable');
          infoSphere.setAttribute(
            'animation',
            'property: position; to: 0 0.06 0; dir: alternate; loop: true; dur: 900; easing: easeInOutSine'
          );

          infoSphere.addEventListener('mouseenter', () => playSound('hover'));
          infoSphere.addEventListener('click', () => {
            if (gazeMoveMode) {
              startGrabHotspotWithGaze(group, hs);
            } else {
              openInfoCard(hs);
            }
          });

          // Halo dorado alrededor
          const halo = document.createElement('a-ring');
          halo.setAttribute('radius-inner', '0.18');
          halo.setAttribute('radius-outer', '0.21');
          halo.setAttribute('color', '#D4AF37');
          halo.setAttribute('material', 'emissive: #D4AF37; emissiveIntensity: 0.55; side: double; transparent: true; opacity: 0.8');
          halo.setAttribute('face-origin', '');

          const label = createFloatingLabelEntity(hs.parsed?.titleEs || 'Ver Pieza', '#D4AF37', 0.34);

          group.appendChild(infoSphere);
          group.appendChild(halo);
          group.appendChild(label);
          container.appendChild(group);
        }
      });

      // 4. Actualizar títulos en 2D y 3D
      updateRoomTitleHUD(scene.title || sceneId);

      // 5. Pre-cargar salas adyacentes para saltos instantáneos
      preloadAdjacentScenes(scene);
    } catch (err) {
      console.error('Error al cargar la escena:', err);
      showToast('Error al conectar con la sala. Reintentando…', 'Reintentar', () => loadScene(sceneId));
    } finally {
      // 6. Fundido de entrada: quitar spinner y desvanecer esfera oscura
      showLoadingHud(false);
      await setFadeSphereOpacity(0, 360);
      isTransitioning = false;
    }
  }

  function exitToStandardView() {
    playSound('click');
    const target = currentSceneId || 'imagen2';
    window.location.href = `index.html?scene=${encodeURIComponent(target)}`;
  }

  function showToast(msg, actionText, actionCallback) {
    const toast = document.querySelector('#vr-toast');
    const toastText = document.querySelector('#vr-toast-text');
    const toastAction = document.querySelector('#vr-toast-action');
    if (!toast || !toastText) return;

    toastText.textContent = msg;
    if (actionText && typeof actionCallback === 'function') {
      toastAction.textContent = actionText;
      toastAction.classList.remove('oculto');
      toastAction.onclick = () => {
        toast.classList.add('oculto');
        actionCallback();
      };
    } else {
      toastAction.classList.add('oculto');
    }

    toast.classList.remove('oculto');
    setTimeout(() => toast.classList.add('oculto'), 5000);
  }

  // ==========================================================================
  // 12. INICIALIZACIÓN PRINCIPAL Y EVENTOS DOM
  // ==========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    renderHudButtons();

    // Sincronizar el estado visual de VR con el elemento body
    const sceneEl = document.querySelector('#escena-vr');
    if (sceneEl) {
      sceneEl.addEventListener('enter-vr', () => document.body.classList.add('en-vr'));
      sceneEl.addEventListener('exit-vr', () => document.body.classList.remove('en-vr'));
    }

    // Eventos de botones de la cédula 3D
    const btnLang = document.querySelector('#card-btn-lang');
    if (btnLang) {
      btnLang.addEventListener('click', () => {
        if (!activeCardState.isOpen || !activeCardState.hasEnglish) return;
        playSound('click');
        activeCardState.lang = activeCardState.lang === 'es' ? 'en' : 'es';
        activeCardState.pageIndex = 0;
        renderActiveCardToCanvas();
      });
    }

    const btnPrev = document.querySelector('#card-btn-prev');
    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        if (!activeCardState.isOpen) return;
        playSound('click');
        activeCardState.pageIndex = Math.max(0, activeCardState.pageIndex - 1);
        renderActiveCardToCanvas();
      });
    }

    const btnNext = document.querySelector('#card-btn-next');
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        if (!activeCardState.isOpen) return;
        playSound('click');
        activeCardState.pageIndex += 1;
        renderActiveCardToCanvas();
      });
    }

    const btnCardClose = document.querySelector('#card-close');
    if (btnCardClose) {
      btnCardClose.addEventListener('click', closeInfoCard);
    }

    // Eventos de la consola 3D inferior
    document.querySelector('#hud-btn-map')?.addEventListener('click', openMap3D);
    document.querySelector('#map-3d-close')?.addEventListener('click', closeMap3D);
    document.querySelector('#hud-btn-edit')?.addEventListener('click', toggleGazeMoveMode);
    document.querySelector('#gaze-drop-btn')?.addEventListener('click', releaseGrabbedHotspot);
    document.querySelector('#hud-btn-exit')?.addEventListener('click', exitToStandardView);

    // Eventos de la barra 2D superior
    document.querySelector('#map-btn-2d')?.addEventListener('click', openMap3D);
    document.querySelector('#exit-btn')?.addEventListener('click', exitToStandardView);

    // Modal de ayuda
    const helpBtn = document.querySelector('#help-btn');
    const helpModal = document.querySelector('#vr-help');
    const helpClose = document.querySelector('#help-close');
    if (helpBtn && helpModal) {
      helpBtn.addEventListener('click', () => {
        playSound('click');
        helpModal.classList.remove('oculto');
      });
    }
    if (helpClose && helpModal) {
      helpClose.addEventListener('click', () => {
        playSound('click');
        helpModal.classList.add('oculto');
      });
    }

    // Actualizar barra de progreso del cargador inicial
    const loaderBar = document.querySelector('#loader-bar-fill');
    const loaderDetail = document.querySelector('#loader-detail');
    const setLoaderProgress = (percent, detail) => {
      if (loaderBar) loaderBar.style.width = `${percent}%`;
      if (loaderDetail && detail) loaderDetail.textContent = detail;
    };

    setLoaderProgress(25, 'Conectando con el museo…');

    // Cargar tour.json
    const urlParams = new URLSearchParams(window.location.search);
    const requestedScene = urlParams.get('scene');

    fetch(JSON_URL)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setLoaderProgress(60, 'Descargando salas y cédulas…');
        return res.json();
      })
      .then(async data => {
        tourData = data;
        setLoaderProgress(85, 'Generando entorno inmersivo…');

        const defaultScene =
          (data.default && data.default.firstScene) || Object.keys(data.scenes)[0];
        const startScene =
          requestedScene && data.scenes[requestedScene] ? requestedScene : defaultScene;

        await loadScene(startScene);

        setLoaderProgress(100, '¡Todo listo!');
        const loader = document.querySelector('#vr-loader');
        if (loader) {
          loader.classList.add('hecho');
          setTimeout(() => loader.remove(), 1000);
        }
      })
      .catch(err => {
        console.error('Error al cargar tour.json:', err);
        if (loaderDetail) {
          loaderDetail.textContent = 'Error al cargar los datos. Reintentando…';
        }
        showToast('No se pudo cargar tour.json.', 'Reintentar', () => window.location.reload());
      });
  });
})();
