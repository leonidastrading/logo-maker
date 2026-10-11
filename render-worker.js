// Renders the exact (export-quality) preview off the main thread so the
// sliders never stall while it runs.
importScripts('render.js');

let supported = false;
try { supported = !!new OffscreenCanvas(1, 1).getContext('2d'); } catch (e) {}
postMessage({ ready: supported });

onmessage = ({ data: { id, scene, size } }) => {
  const { field, r } = renderField(scene, size, 0, 0, size, size);
  const img = composite(field, size, size, r, false, scene.invert);
  postMessage({ id, buf: img.data.buffer, size }, [img.data.buffer]);
};
