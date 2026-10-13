import * as Cesium from 'cesium';
import { localCoordinate, CHARLOTTE_BOUNDS } from './model.js';

/** Static, bounded local observations. No animation holds or background timers. */
export function createCharlotteLayer({ definition, source, picking, createClickHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas) }) {
  let viewer,
    dataSource,
    handler,
    removeCameraListener,
    request,
    enabled = false,
    rows = [],
    stats = {},
    panel;
  const prefix = `${definition.id}:`;
  const clearPanel = () => {
    panel?.remove();
    panel = null;
  };
  const showDetails = (row) => {
    clearPanel();
    panel = document.createElement('section');
    panel.setAttribute('aria-label', `${definition.name} event details`);
    Object.assign(panel.style, {
      position: 'absolute',
      left: '16px',
      bottom: '70px',
      zIndex: '25',
      width: 'min(360px, calc(100vw - 32px))',
      maxHeight: '50vh',
      overflow: 'auto',
      background: '#101820f5',
      color: '#fff',
      border: `1px solid ${definition.color}`,
      borderRadius: '8px',
      padding: '16px',
      font: '13px system-ui',
    });
    const close = document.createElement('button');
    close.textContent = 'Close';
    close.onclick = clearPanel;
    close.style.float = 'right';
    panel.append(close);
    const title = document.createElement('h3');
    title.textContent = row.title;
    panel.append(title);
    const formatter = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/New_York',
    });
    const lines = [
      definition.source,
      row.state,
      row.description,
      row.details,
      row.detour && `Detour: ${row.detour}`,
      ...[
        ['Reported / updated', row.reportedAt],
        ['Starts', row.startsAt],
        ['Ends', row.endsAt],
      ]
        .filter(([, value]) => value && Number.isFinite(Date.parse(value)))
        .map(
          ([label, value]) =>
            `${label}: ${formatter.format(new Date(value))} (Eastern)`,
        ),
      stats.error && 'Refresh failed; this is the last successful snapshot.',
    ];
    for (const line of lines.filter(Boolean)) {
      const p = document.createElement('p');
      p.textContent = line;
      panel.append(p);
    }
    if (row.viewerUrl) {
      const url = new URL(row.viewerUrl);
      if (
        url.origin === 'https://drivenc.gov' &&
        /^\/map\/Cctv\/\d+$/.test(url.pathname)
      ) {
        const a = document.createElement('a');
        a.href = url.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open official camera image';
        const image = document.createElement('img');
        image.src = url.href;
        image.alt = row.title;
        image.style.width = '100%';
        image.loading = 'lazy';
        image.onerror = () => {
          image.remove();
          a.textContent = 'Camera image unavailable — retry official image';
        };
        panel.append(image);
        a.style.color = definition.color;
        panel.append(a);
      }
    }
    viewer.container.append(panel);
  };
  const layer = {
    ...definition,
    init(v) {
      viewer = v;
      dataSource = new Cesium.CustomDataSource(definition.id);
      dataSource.show = false;
      v.dataSources.add(dataSource);
    },
    enable() {
      if (enabled) return;
      enabled = true;
      dataSource.show = true;
      picking.registerPickOwner(definition.id, (id) => id.startsWith(prefix));
      handler = createClickHandler(viewer.scene.canvas);
      removeCameraListener = viewer.camera?.moveEnd?.addEventListener(() => {
        void layer.update();
      });
      handler.setInputAction((event) => {
        const id = picking.resolvePickId(viewer.scene.pick(event.position));
        if (!id?.startsWith(prefix)) return;
        const row = rows.find(
          (r) =>
            `${prefix}${r.id}` === id ||
            id.startsWith(`${prefix}${r.id}:path:`),
        );
        if (row) showDetails(row);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    disable() {
      enabled = false;
      removeCameraListener?.();
      removeCameraListener = null;
      request?.abort();
      request = null;
      if (dataSource) dataSource.show = false;
      handler?.destroy();
      handler = null;
      picking.unregisterPickOwner(definition.id);
      clearPanel();
      stats.loading = false;
    },
    async update(_viewer, { signal } = {}) {
      if (signal?.aborted || !enabled || !dataSource) return false;
      if (request) return true;
      const view = viewer.camera?.computeViewRectangle(
        viewer.scene.globe.ellipsoid,
      );
      if (view) {
        const bounds = Cesium.Rectangle.fromDegrees(
          CHARLOTTE_BOUNDS.west,
          CHARLOTTE_BOUNDS.south,
          CHARLOTTE_BOUNDS.east,
          CHARLOTTE_BOUNDS.north,
        );
        if (
          !Cesium.Rectangle.intersection(view, bounds) ||
          viewer.camera.positionCartographic.height > 1000000
        ) {
          stats.status = 'zoom-in';
          return true;
        }
      }
      stats.status = null;
      const controller = new AbortController();
      request = controller;
      stats.loading = true;
      try {
        const payload = await source.getSnapshot(definition.feed, {
          signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        });
        if (!enabled || request !== controller || controller.signal.aborted || signal?.aborted)
          return false;
        rows = payload.rows
          .filter((r) => localCoordinate(r.lon, r.lat))
          .slice(0, 2000);
        dataSource.entities.suspendEvents();
        try {
          const keep = new Set();
          for (const row of rows) {
            const id = `${prefix}${row.id}`;
            keep.add(id);
            const color = Cesium.Color.fromCssColorString(
              row.state.startsWith('Upcoming') ? '#8899aa' : definition.color,
            );
            let entity = dataSource.entities.getById(id);
            if (!entity) entity = dataSource.entities.add({ id });
            entity.position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
            entity.point = {
              pixelSize: 10,
              color,
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: 250000,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                250000,
              ),
            };
            entity.label = {
              text: row.title.slice(0, 60),
              font: '12px sans-serif',
              fillColor: color,
              showBackground: true,
              pixelOffset: new Cesium.Cartesian2(0, -22),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                0,
                15000,
              ),
            };
            for (const [index, path] of (row.paths || []).entries()) {
              const pathId = `${id}:path:${index}`;
              keep.add(pathId);
              const line =
                dataSource.entities.getById(pathId) ||
                dataSource.entities.add({ id: pathId });
              line.polyline = {
                positions: Cesium.Cartesian3.fromDegreesArray(path.flat()),
                width: 4,
                material: color,
                clampToGround: true,
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
                  0,
                  250000,
                ),
              };
            }
          }
          for (const entity of [...dataSource.entities.values])
            if (!keep.has(entity.id)) dataSource.entities.remove(entity);
        } finally {
          dataSource.entities.resumeEvents();
        }
        clearPanel();
        stats = {
          count: rows.length,
          lastUpdate: payload.fetchedAt,
          partial: payload.partial,
          error: null,
          loading: false,
        };
        viewer.scene.requestRender();
        return true;
      } catch (e) {
        if (!controller.signal.aborted && request === controller) {
          stats.error = e.message;
          stats.stale = Boolean(stats.lastUpdate);
          clearPanel();
        }
        // A feed outage is a refresh error, not a rejected layer startup.
        return enabled && !controller.signal.aborted && !signal?.aborted;
      } finally {
        if (request === controller) {
          request = null;
          stats.loading = false;
        }
      }
    },
    getStats() {
      return { count: rows.length, ...stats };
    },
    getAnalystRecords(max = 2000) {
      return enabled
        ? rows.slice(0, max).map((r) => ({
            ...r,
            layerId: definition.id,
            source: definition.source,
          }))
        : [];
    },
    destroy() {
      layer.disable();
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      rows = [];
      stats = {};
    },
  };
  return layer;
}
