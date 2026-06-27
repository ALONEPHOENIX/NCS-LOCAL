/**
 * Antigravity Background Particle System + Animated Textured Gradient
 * Vanilla 2D Canvas backdrop combined with Three.js rising particles.
 */
(function() {

  // ─── 1. Animated Textured Gradient (2D Canvas) ───
  const gradCanvas = document.getElementById('gradient-canvas');
  if (gradCanvas) {
    const ctx = gradCanvas.getContext('2d');
    
    function resizeGrad() {
      gradCanvas.width = window.innerWidth / 2; // Downscale canvas slightly for smooth performance
      gradCanvas.height = window.innerHeight / 2;
    }
    window.addEventListener('resize', resizeGrad);
    resizeGrad();

    // Blobs definitions
    const blobs = [
      { x: 0.2, y: 0.3, vx: 0.001, vy: 0.0015, r: 0.6, h: 211, s: 80, l: 45 },
      { x: 0.8, y: 0.2, vx: -0.0015, vy: 0.001, r: 0.7, h: 245, s: 80, l: 55 },
      { x: 0.4, y: 0.9, vx: 0.0005, vy: -0.001, r: 0.5, h: 34, s: 80, l: 35 },
      { x: 0.9, y: 0.7, vx: -0.001, vy: -0.0005, r: 0.5, h: 211, s: 80, l: 75 }
    ];

    let backgroundFill = '#0e111a';

    // Helper: Convert RGB to HSL
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;

      if (max === min) {
        h = s = 0; // achromatic
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }

      return {
        h: Math.round(h * 360),
        s: Math.round(s * 100),
        l: Math.round(l * 100)
      };
    }

    // Expose a function to update background colors dynamically when theme color or settings change
    window.updateBackgroundColors = function() {
      const theme = window.themeColor || { r: 142, g: 149, b: 194 };
      const hsl = rgbToHsl(theme.r, theme.g, theme.b);

      // Generate cohesive color variations by shifting HSL values
      // Blob 0: Primary color family (medium-dark)
      blobs[0].h = (hsl.h - 15 + 360) % 360;
      blobs[0].s = Math.min(100, Math.max(30, hsl.s + 10));
      blobs[0].l = Math.min(85, Math.max(20, hsl.l - 10));

      // Blob 1: Soft accent (lighter)
      blobs[1].h = (hsl.h + 15) % 360;
      blobs[1].s = Math.min(100, Math.max(30, hsl.s));
      blobs[1].l = Math.min(85, Math.max(20, hsl.l + 5));

      // Blob 2: Deep shadow variant (contrasting hue or darker primary)
      blobs[2].h = (hsl.h - 40 + 360) % 360;
      blobs[2].s = Math.min(100, Math.max(30, hsl.s + 15));
      blobs[2].l = Math.min(85, Math.max(10, hsl.l - 20));

      // Blob 3: Light pastel glow
      blobs[3].h = (hsl.h + 40) % 360;
      blobs[3].s = Math.min(100, Math.max(20, hsl.s - 15));
      blobs[3].l = Math.min(90, Math.max(30, hsl.l + 15));

      if (window.audioEngine && window.audioEngine.settings) {
        backgroundFill = window.audioEngine.settings.backgroundTint;
      } else {
        backgroundFill = `hsl(${hsl.h}, ${Math.max(10, hsl.s - 20)}%, 7%)`;
      }
    };

    // Run once at start
    window.updateBackgroundColors();

    function animateGrad() {
      ctx.fillStyle = backgroundFill;
      ctx.fillRect(0, 0, gradCanvas.width, gradCanvas.height);

      blobs.forEach(blob => {
        // Animate blob coordinates
        blob.x += blob.vx;
        blob.y += blob.vy;

        // Bounce off edges
        if (blob.x < 0 || blob.x > 1) blob.vx *= -1;
        if (blob.y < 0 || blob.y > 1) blob.vy *= -1;

        const screenX = blob.x * gradCanvas.width;
        const screenY = blob.y * gradCanvas.height;
        const radius = blob.r * Math.max(gradCanvas.width, gradCanvas.height);

        // Create a soft radial gradient for the color blob
        const gradient = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, radius);
        gradient.addColorStop(0, `hsla(${blob.h}, ${blob.s}%, ${blob.l}%, 1)`);
        gradient.addColorStop(1, `hsla(${blob.h}, ${blob.s}%, ${blob.l}%, 0)`);

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, gradCanvas.width, gradCanvas.height);
      });

      requestAnimationFrame(animateGrad);
    }
    animateGrad();
  }


  // ─── 2. Antigravity Particles (Three.js) ───
  const particleCanvas = document.getElementById('antigravity-canvas');
  if (particleCanvas) {
    const options = {
      count: 1800,
      magnetRadius: 6,
      ringRadius: 7,
      waveSpeed: 0.4,
      waveAmplitude: 1,
      particleSize: 1.6,
      lerpSpeed: 0.05,
      autoAnimate: true,
      particleVariance: 1,
      rotationSpeed: 0,
      depthFactor: 1,
      pulseSpeed: 3,
      particleShape: 'capsule',
      fieldStrength: 10,
      color: '#ffffff'
    };

    // Setup Three.js scene
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 50;

    const renderer = new THREE.WebGLRenderer({ canvas: particleCanvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.autoClear = true; // Clear on each frame (transparency over background)

    // Viewport calculation at camera distance
    let viewportHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    let viewportWidth = viewportHeight * (window.innerWidth / window.innerHeight);

    // Particle Setup
    let geometry;
    if (options.particleShape === 'capsule') {
      geometry = new THREE.CylinderGeometry(0.04, 0.04, 0.11, 8);
    } else if (options.particleShape === 'sphere') {
      geometry = new THREE.SphereGeometry(0.1, 12, 12);
    } else if (options.particleShape === 'box') {
      geometry = new THREE.BoxGeometry(0.15, 0.15, 0.15);
    } else {
      geometry = new THREE.TetrahedronGeometry(0.15);
    }

    const material = new THREE.MeshBasicMaterial({ color: options.color });
    const mesh = new THREE.InstancedMesh(geometry, material, options.count);
    scene.add(mesh);

    // Setup pointer tracking
    let pointer = { x: 0, y: 0 };
    window.addEventListener('mousemove', (e) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });

    window.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        pointer.x = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
        pointer.y = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
      }
    });

    const particles = [];
    const dummy = new THREE.Object3D();

    for (let i = 0; i < options.count; i++) {
      const t = Math.random() * 100;
      const factor = 20 + Math.random() * 100;
      const speed = 0.01 + Math.random() / 200;

      const x = (Math.random() - 0.5) * (viewportWidth * 2.5);
      const y = (Math.random() - 0.5) * (viewportHeight * 2.5);
      const z = (Math.random() - 0.5) * 45;

      const randomRadiusOffset = (Math.random() - 0.5) * 2;

      particles.push({
        t,
        factor,
        speed,
        mx: x,
        my: y,
        mz: z,
        cx: x,
        cy: y,
        cz: z,
        randomRadiusOffset
      });
    }

    let lastMouseMoveTime = Date.now();
    let virtualMouse = { x: 0, y: 0 };
    const clock = new THREE.Clock();

    window.addEventListener('mousemove', () => {
      lastMouseMoveTime = Date.now();
    });

    function animateParticles() {
      requestAnimationFrame(animateParticles);

      const time = clock.getElapsedTime();
      const dt = Math.min(clock.getDelta(), 0.1);

      let destX = (pointer.x * viewportWidth) / 2;
      let destY = (pointer.y * viewportHeight) / 2;

      if (options.autoAnimate && Date.now() - lastMouseMoveTime > 2000) {
        destX = Math.sin(time * 0.5) * (viewportWidth / 4);
        destY = Math.cos(time * 0.5 * 2) * (viewportHeight / 4);
      }

      const smoothFactor = 0.05;
      virtualMouse.x += (destX - virtualMouse.x) * smoothFactor;
      virtualMouse.y += (destY - virtualMouse.y) * smoothFactor;

      const targetX = virtualMouse.x;
      const targetY = virtualMouse.y;

      const globalRotation = time * options.rotationSpeed;

      particles.forEach((p, i) => {
        p.t += p.speed / 2;

        const projectionFactor = 1 - p.cz / 50;
        const projectedTargetX = targetX * projectionFactor;
        const projectedTargetY = targetY * projectionFactor;

        const dx = p.mx - projectedTargetX;
        const dy = p.my - projectedTargetY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let targetPos = { x: p.mx, y: p.my, z: p.mz * options.depthFactor };

        if (dist < options.magnetRadius) {
          const angle = Math.atan2(dy, dx) + globalRotation;
          const wave = Math.sin(p.t * options.waveSpeed + angle) * (0.5 * options.waveAmplitude);
          const deviation = p.randomRadiusOffset * (5 / (options.fieldStrength + 0.1));
          const currentRingRadius = options.ringRadius + wave + deviation;

          targetPos.x = projectedTargetX + currentRingRadius * Math.cos(angle);
          targetPos.y = projectedTargetY + currentRingRadius * Math.sin(angle);
          targetPos.z = p.mz * options.depthFactor + Math.sin(p.t) * (options.waveAmplitude * options.depthFactor);
        }

        p.cx += (targetPos.x - p.cx) * options.lerpSpeed;
        p.cy += (targetPos.y - p.cy) * options.lerpSpeed;
        p.cz += (targetPos.z - p.cz) * options.lerpSpeed;

        dummy.position.set(p.cx, p.cy, p.cz);
        dummy.lookAt(projectedTargetX, projectedTargetY, p.cz);
        dummy.rotateX(Math.PI / 2);

        const currentDistToMouse = Math.sqrt(
          Math.pow(p.cx - projectedTargetX, 2) + Math.pow(p.cy - projectedTargetY, 2)
        );

        const distFromRing = Math.abs(currentDistToMouse - options.ringRadius);
        let scaleFactor = 1 - distFromRing / 10;
        scaleFactor = Math.max(0, Math.min(1, scaleFactor));

        const finalScale = scaleFactor * (0.8 + Math.sin(p.t * options.pulseSpeed) * 0.2 * options.particleVariance) * options.particleSize;
        dummy.scale.set(finalScale, finalScale, finalScale);

        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });

      mesh.instanceMatrix.needsUpdate = true;
      renderer.render(scene, camera);
    }

    // Handle resizing
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();

      renderer.setSize(window.innerWidth, window.innerHeight);

      viewportHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
      viewportWidth = viewportHeight * (window.innerWidth / window.innerHeight);
    });

    animateParticles();
  }

})();
