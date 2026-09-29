// Instrument cluster in the HUD: speedometer, tachometer (with a red zone), and a gear indicator
// between them, with a camera icon while the follow camera is on and an optional perf card. Drawn with plain meshes in the screen-space HUD scene (CSS pixels, y up, origin at
// the top-left corner) and Glyph text for the numbers.
import { CircleGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, RingGeometry, Shape, ShapeGeometry } from 'three/webgpu';

const START = (225 * Math.PI) / 180; // dial zero at the lower left
const SWEEP = (270 * Math.PI) / 180; // clockwise to the lower right

const material = (color, opacity = 1) =>
  new MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
const FACE = material('#1f1d19', 0.62);
const RIM = material('#efe6d0', 0.9);
const TICK = material('#efe6d0', 0.95);
const MINOR = material('#efe6d0', 0.55);
const RED = material('#e0533a', 0.95);
const NEEDLE = material('#e8743f');
const CAP = material('#2b2823');
const GEAR_FACE = material('#1f1d19', 0.9);
const CARD_FACE = material('#1f1d19', 0.82);

// Needle pointing along +x, pivot at the origin: a long thin triangle with a short tail.
function needleGeometry(length, width) {
  const s = new Shape();
  s.moveTo(-length * 0.16, -width);
  s.lineTo(length, -width * 0.25);
  s.lineTo(length, width * 0.25);
  s.lineTo(-length * 0.16, width);
  s.closePath();
  return new ShapeGeometry(s);
}

// Rounded rectangle centred on the origin.
function roundedRect(w, h, r) {
  const s = new Shape();
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - r, -h / 2);
  s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  s.lineTo(w / 2, h / 2 - r);
  s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  return new ShapeGeometry(s, 6);
}

// HUD meshes all sit at z ≈ 0 with depth testing off, so draw order comes from renderOrder.
function layer(mesh, order, z = order * 0.01) {
  mesh.renderOrder = order;
  mesh.position.z = z;
  return mesh;
}

const angleOf = (fraction) => START - Math.max(-0.02, Math.min(1.03, fraction)) * SWEEP;

// Critically damped follow, so needles swing smoothly instead of jumping. Integrated in short
// steps: a slow frame (dt up to 0.1 s) would otherwise make the needle overshoot wildly.
function follow(state, target, dt, hz = 5) {
  const w = 2 * Math.PI * hz;
  const steps = Math.ceil(dt / 0.004);
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    state.v += (w * w * (target - state.x) - 2 * w * state.v) * h;
    state.x += state.v * h;
  }
}

// Text centred on a point (Glyph lays text out from its top-left corner).
// `chars` sets the box width (in font sizes) the text is centred in.
function centredText(hud, font, text, size, color, chars = 6) {
  let fontSize = size;
  let width = fontSize * chars;
  const t = hud.createText({
    font,
    text,
    style: { fontSize, lineHeight: 1, color },
    layout: { align: 'center', wrap: 'none' },
    constraints: { width: { mode: 'exact', size: width } },
  });
  return {
    object: (t.renderOrder = 8, t),
    setSize(next) {
      if (next === fontSize) return;
      fontSize = next;
      width = fontSize * chars;
      t.style = { fontSize, lineHeight: 1, color };
      t.constraints = { width: { mode: 'exact', size: width } };
    },
    place(x, y) {
      t.position.set(x - width / 2, y + fontSize * 0.5, 1);
    },
    set(value) {
      if (t.text !== value) t.text = value;
    },
  };
}

// One round dial. `labels` are drawn at `majors` (fractions 0..1); `red` is the red-zone start.
function createDial(hud, font, { majors, minors, labels, unit, red = null }) {
  const group = new Group();
  const parts = { group, texts: [], radius: 0 };
  parts.build = (R) => {
    group.clear();
    group.add(layer(new Mesh(new CircleGeometry(R, 48), FACE), 1));
    group.add(layer(new Mesh(new RingGeometry(R - 2, R, 64), RIM), 2));
    if (red !== null) {
      const a0 = angleOf(1);
      const a1 = angleOf(red);
      group.add(layer(new Mesh(new RingGeometry(R * 0.8, R * 0.9, 24, 1, a0, a1 - a0), RED), 2));
    }
    const tick = (f, length, width, mat) => {
      const a = angleOf(f);
      const m = new Mesh(new PlaneGeometry(length, width), mat);
      const r = R * 0.9 - length / 2;
      m.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      m.rotation.z = a;
      group.add(layer(m, 3));
    };
    for (const f of minors) tick(f, R * 0.07, Math.max(1, R * 0.018), MINOR);
    for (const f of majors) tick(f, R * 0.14, Math.max(1.5, R * 0.035), f >= (red ?? 2) ? RED : TICK);
    parts.needle = layer(new Mesh(needleGeometry(R * 0.78, Math.max(2, R * 0.045)), NEEDLE), 5);
    group.add(parts.needle);
    group.add(layer(new Mesh(new CircleGeometry(R * 0.1, 24), CAP), 6));
    parts.radius = R;
  };
  parts.labels = labels.map((l) => centredText(hud, font, l, 12, '#efe6d0'));
  parts.unit = centredText(hud, font, unit, 10, '#b9af97');
  parts.readout = centredText(hud, font, '0', 15, '#fff6e2');
  parts.state = { x: 0, v: 0 };
  parts.place = (cx, cy) => {
    group.position.set(cx, cy, 0);
    const R = parts.radius;
    const fontSize = Math.max(9, Math.round(R * 0.17));
    parts.labels.forEach((t, i) => {
      const a = angleOf(majors[i]);
      t.setSize(fontSize);
      t.place(cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6);
    });
    parts.unit.setSize(Math.max(8, Math.round(R * 0.13)));
    parts.unit.place(cx, cy + R * 0.34);
    parts.readout.setSize(Math.max(10, Math.round(R * 0.2)));
    parts.readout.place(cx, cy - R * 0.6);
  };
  parts.update = (fraction, dt) => {
    follow(parts.state, fraction, dt);
    parts.needle.rotation.z = angleOf(parts.state.x);
  };
  return parts;
}

// A small camera (body, viewfinder, lens) of width `s`, centred on the origin.
function cameraIcon(s) {
  const icon = new Group();
  const h = s * 0.62;
  icon.add(layer(new Mesh(roundedRect(s, h, s * 0.12), NEEDLE), 3));
  const bump = layer(new Mesh(roundedRect(s * 0.36, s * 0.24, s * 0.06), NEEDLE), 3);
  bump.position.set(-s * 0.14, h / 2, bump.position.z);
  icon.add(bump);
  icon.add(layer(new Mesh(new CircleGeometry(s * 0.22, 24), GEAR_FACE), 4));
  icon.add(layer(new Mesh(new CircleGeometry(s * 0.11, 20), NEEDLE), 5));
  return icon;
}

// Safe-area insets at the top and left of the screen (the notch on a phone), in CSS pixels.
let insetProbe = null;
function safeInsets() {
  if (!globalThis.document) return { top: 0, left: 0 };
  if (!insetProbe) {
    insetProbe = document.createElement('div');
    insetProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-left:env(safe-area-inset-left)';
    document.body.append(insetProbe);
  }
  const style = getComputedStyle(insetProbe);
  return { top: parseFloat(style.paddingTop) || 0, left: parseFloat(style.paddingLeft) || 0 };
}

// Height kept clear at the top for the folded tuning panel's title bar (see index.html).
const PANEL_BAR = 48;

export function createGauges({ hud, font, scene }) {
  const root = new Group();
  root.renderOrder = 10;
  scene.add(root);

  const speedMax = 100; // km/h
  const rpmMax = 6000;
  const speed = createDial(hud, font, {
    majors: [0, 0.2, 0.4, 0.6, 0.8, 1],
    minors: Array.from({ length: 10 }, (_, i) => (i + 0.5) / 10),
    labels: ['0', '20', '40', '60', '80', '100'],
    unit: 'km/h',
  });
  const tach = createDial(hud, font, {
    majors: [0, 1, 2, 3, 4, 5, 6].map((k) => k / 6),
    minors: Array.from({ length: 6 }, (_, i) => (i + 0.5) / 6),
    labels: ['0', '1', '2', '3', '4', '5', '6'],
    unit: 'x1000 rpm',
    red: 5400 / rpmMax,
  });
  root.add(speed.group, tach.group);

  const gearBox = new Group();
  root.add(gearBox);
  const gearText = centredText(hud, font, 'N', 40, '#fff6e2');
  const modeText = centredText(hud, font, 'AUTO', 10, '#b9af97');
  const lowText = centredText(hud, font, '', 11, '#e8743f');

  const followIcon = new Group();
  followIcon.visible = false;
  root.add(followIcon);

  // Perf card: two lines of stats on a dark plate, shown with P or the panel's switch.
  const perfCard = new Group();
  perfCard.visible = false;
  root.add(perfCard);
  const perfLines = [centredText(hud, font, '', 12, '#fff6e2', 22), centredText(hud, font, '', 12, '#efe6d0', 22)];

  const texts = [...speed.labels, speed.unit, speed.readout, ...tach.labels, tach.unit, tach.readout, gearText, modeText, lowText, ...perfLines];
  for (const t of texts) scene.add(t.object);

  let size = null;
  // Bottom centre, sized to the free space between the touch buttons (or the whole width).
  // On narrow touch screens the cluster moves to the top, below the folded tuning panel. The perf
  // card sits on top of the cluster when there is room, below it when the cluster is at the top,
  // and in the top left corner of short screens (a phone on its side) so it does not cover the car.
  const layout = (w, h, touch) => {
    const key = `${w}x${h}:${touch}`;
    if (key === size) return;
    size = key;
    const free = touch ? w - 470 : Math.min(w - 56, 720);
    let R = Math.min(76, Math.max(40, free / 5.8));
    let top = false;
    if (touch && free / 5.8 < 44) {
      R = Math.min(62, Math.max(34, (w - 40) / 5.8));
      top = true;
    }
    speed.build(R);
    tach.build(R);
    const boxW = R * 1.0;
    const boxH = R * 1.1;
    gearBox.clear();
    gearBox.add(layer(new Mesh(roundedRect(boxW, boxH, R * 0.16), RIM), 1));
    gearBox.add(layer(new Mesh(roundedRect(boxW - 4, boxH - 4, R * 0.14), GEAR_FACE), 2));
    const gap = R * 0.22;
    const cx = w / 2;
    const inset = safeInsets();
    const cy = top ? -(Math.max(12, inset.top) + PANEL_BAR + R) : -h + R + 22;
    speed.place(cx - boxW / 2 - gap - R, cy);
    tach.place(cx + boxW / 2 + gap + R, cy);
    gearBox.position.set(cx, cy, 0);
    gearText.setSize(Math.round(R * 0.6));
    gearText.place(cx, cy + R * 0.02);
    modeText.setSize(Math.max(8, Math.round(R * 0.13)));
    modeText.place(cx, cy + boxH * 0.34);
    lowText.setSize(Math.max(8, Math.round(R * 0.14)));
    lowText.place(cx, cy - boxH * 0.34);

    // Camera icon in the gap above the gear box, between the dials.
    const iconW = R * 0.36;
    followIcon.clear();
    followIcon.add(cameraIcon(iconW));
    followIcon.position.set(cx, cy + boxH / 2 + R * 0.12 + iconW * 0.31, 0);

    const fontSize = Math.max(10, Math.min(13, Math.round(R * 0.17)));
    const cardW = Math.min(w - 24, Math.max(220, R * 3.6));
    const lineH = fontSize * 1.4;
    const cardH = lineH * 2 + fontSize;
    let cardX = cx;
    let cardY;
    if (top) cardY = cy - R - 10 - cardH / 2;
    else if (2 * R + 22 + 10 + cardH < h * 0.3) cardY = cy + R + 10 + cardH / 2;
    else {
      cardX = Math.max(12, inset.left) + cardW / 2;
      cardY = -(Math.max(12, inset.top) + cardH / 2);
    }
    perfCard.clear();
    perfCard.add(layer(new Mesh(roundedRect(cardW, cardH, fontSize * 0.6), RIM), 1));
    perfCard.add(layer(new Mesh(roundedRect(cardW - 3, cardH - 3, fontSize * 0.55), CARD_FACE), 2));
    perfCard.position.set(cardX, cardY, 0);
    perfLines.forEach((t, i) => {
      t.setSize(fontSize);
      t.place(cardX, cardY + lineH * (0.5 - i));
    });
  };

  // `follow`: the follow camera is on. `perf`: two lines of stats, or null to hide the card.
  const update = (vehicle, dt, { follow = false, perf = null } = {}) => {
    followIcon.visible = follow;
    perfCard.visible = !!perf;
    perfLines.forEach((t, i) => {
      t.object.visible = !!perf;
      if (perf) t.set(perf[i] ?? '');
    });
    const kmh = Math.abs(vehicle.speed ?? 0) * 3.6;
    speed.update(kmh / speedMax, dt);
    speed.readout.set(String(Math.round(kmh)));
    const d = vehicle.drivetrain;
    const rpm = d?.rpm ?? 0;
    tach.update(rpm / rpmMax, dt);
    tach.readout.set(String(Math.round(rpm / 50) * 50));
    if (d) {
      const g = d.pendingGear ?? d.gear;
      gearText.set(g < 0 ? 'R' : g === 0 ? 'N' : String(g));
      modeText.set(d.params.automatic ? 'AUTO' : 'MANUAL');
      lowText.set(d.params.low ? 'LOW' : '');
    }
  };

  return { layout, update };
}
