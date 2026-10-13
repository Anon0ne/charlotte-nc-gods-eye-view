import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCharlotteLayer } from './index.js';

function setup(getSnapshot, height = 20000) {
  const camera = { computeViewRectangle: () => Cesium.Rectangle.fromDegrees(-81, 35, -80, 36), positionCartographic: { height }, moveEnd: new Cesium.Event() };
  const viewer = { camera, dataSources: new Cesium.DataSourceCollection(), scene: { canvas: {}, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 }, requestRender() {} } };
  const layer = createCharlotteLayer({ definition: { id: 'charlotte-traffic', feed: 'cmpd', color: '#ff8800' }, source: { getSnapshot }, picking: { registerPickOwner() {}, unregisterPickOwner() {} }, createClickHandler: () => ({ setInputAction() {}, destroy() {} }) });
  layer.init(viewer); layer.enable();
  return { layer, viewer };
}
test('startup away from Charlotte stays enabled and fetches after zooming in', async () => {
  let calls = 0;
  const { layer, viewer } = setup(async () => { calls++; return { rows: [], fetchedAt: Date.now() }; }, 2000000);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().status, 'zoom-in');
  assert.equal(calls, 0);
  viewer.camera.positionCartographic.height = 20000;
  viewer.camera.moveEnd.raiseEvent();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
  assert.equal(viewer.camera.moveEnd.numberOfListeners, 0);
});
test('feed outage does not reject startup and a subsequent refresh recovers', async () => {
  let failed = true;
  const { layer } = setup(async () => { if (failed) throw new Error('Feed unavailable'); return { rows: [], fetchedAt: Date.now() }; });
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'Feed unavailable');
  failed = false;
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});
test('cancelled startup still reports cancellation', async () => {
  const { layer } = setup(async () => ({ rows: [] }));
  const controller = new AbortController(); controller.abort();
  assert.equal(await layer.update(undefined, { signal: controller.signal }), false);
  layer.destroy();
});
