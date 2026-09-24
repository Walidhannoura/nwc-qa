/* قراءة الـ Geodatabase (أو GeoPackage) بواسطة GDAL وتجهيز البيانات لمحرك الفحص.
 * بيشتغل في المتصفح (gdal3.js) وفي Node (للاختبار) بنفس الكود.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./qa-engine.js'));
  else root.GdalReader = factory(root.QAEngine);
})(typeof self !== 'undefined' ? self : this, function (QA) {
  'use strict';

  var counter = 0;
  function userError(msg) { var e = new Error(msg); e.userMessage = msg; return e; }
  function clean(v) {
    var x = QA.num(v);
    return x === null ? null : parseFloat(x.toPrecision(15));
  }
  function quote(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }

  // ---------------------------------------------------------- فتح الملف
  // قراءة قائمة ملفات الـ ZIP من الـ central directory (بدون تحميل الملف كله)
  async function listZipEntries(blob) {
    var size = blob.size, tailLen = Math.min(size, 66000);
    var tail = new DataView(await blob.slice(size - tailLen, size).arrayBuffer());
    var eocd = -1;
    for (var i = tailLen - 22; i >= 0; i--) { if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw userError('الملف ده مش ZIP سليم.');
    var count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {  // zip64
      var locPos = eocd - 20;
      if (locPos < 0 || tail.getUint32(locPos, true) !== 0x07064b50) throw userError('صيغة ZIP غير مدعومة.');
      var z64Off = Number(tail.getBigUint64(locPos + 8, true));
      var z = new DataView(await blob.slice(z64Off, z64Off + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    var cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    var utf8 = new TextDecoder('utf-8'), latin = new TextDecoder('latin1');
    var names = [], p = 0;
    while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
      var flags = cd.getUint16(p + 8, true), nLen = cd.getUint16(p + 28, true), xLen = cd.getUint16(p + 30, true), cLen = cd.getUint16(p + 32, true);
      var raw = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nLen);
      names.push((flags & 0x800 ? utf8 : latin).decode(raw));
      p += 46 + nLen + xLen + cLen;
    }
    return names;
  }

  async function tryOpen(Gdal, src, vfs) {
    try {
      var r = await Gdal.open(src, [], vfs);
      return r && r.datasets && r.datasets.length ? r.datasets[0] : null;
    } catch (e) { return null; }
  }

  /** file: كائن File (متصفح) أو مسار نصي (Node) */
  async function openDataset(Gdal, file) {
    var isNode = typeof file === 'string';
    var name = isNode ? file.split('/').pop() : file.name;
    if (/\.gpkg$/i.test(name)) {
      var g = await tryOpen(Gdal, isNode ? file : new File([file], 'upload.gpkg'), []);
      if (!g) throw userError('تعذر فتح ملف GeoPackage.');
      return g;
    }
    if (!/\.zip$/i.test(name)) throw userError('نوع الملف غير مدعوم. ارفع ملف ZIP فيه الـ Geodatabase أو ملف GeoPackage.');

    var src = isNode ? file : new File([file], 'upload.zip');
    var mountName = isNode ? name : 'upload.zip';
    // 1) الحالة الشائعة: مجلد .gdb على الجذر
    var ds = await tryOpen(Gdal, src, ['vsizip']);
    if (ds) return ds;

    // 2) شكل تاني للـ ZIP: نقرا محتوياته
    var names;
    try { names = await listZipEntries(isNode ? new Blob([require('fs').readFileSync(file)]) : file); }
    catch (e) { throw e.userMessage ? e : userError('الملف ده مش ZIP سليم. اضغط مجلد الـ Geodatabase كله وارفعه تاني.'); }

    var dirs = [];
    names.forEach(function (n) {
      var m = /^(.*?[^\/]+\.gdb)\//i.exec(n);
      if (m && dirs.indexOf(m[1]) < 0) dirs.push(m[1]);
    });
    for (var i = 0; i < dirs.length; i++) {         // .gdb جوه مجلدات
      ds = await tryOpen(Gdal, '/input/' + mountName + '/' + dirs[i], ['vsizip']);
      if (ds) return ds;
    }
    var flat = names.some(function (n) { return /^a00000001\.gdbtable$/i.test(n); });
    if (flat && !isNode) {                          // محتويات الـ gdb على الجذر بدون المجلد
      ds = await tryOpen(Gdal, new File([file], 'upload.gdb.zip'), []);
      if (ds) return ds;
    }
    if (dirs.length || flat) throw userError('لقيت الـ Geodatabase لكن تعذر فتحها. تأكد إن الملف غير تالف.');
    throw userError('مالقيتش مجلد Geodatabase جوه الملف. اضغط مجلد الـ Geodatabase كله (ZIP) وارفعه.');
  }

  // ------------------------------------------------------ قراءة الطبقات
  async function layerInfo(Gdal, ds) {
    var info = await Gdal.ogrinfo(ds, ['-so', '-al', '-json']);
    return (info.layers || []).map(function (l) {
      var gf = (l.geometryFields && l.geometryFields[0]) || {};
      return {
        name: l.name, type: String(gf.type || ''), count: l.featureCount,
        fields: (l.fields || []).map(function (f) { return f.name; }),
        wkt: (gf.coordinateSystem && gf.coordinateSystem.wkt) || null
      };
    });
  }

  async function exportGeoJSON(Gdal, ds, layer, fieldNames, extra) {
    var sel = ['FID AS "__OID__"'].concat(fieldNames.map(quote)).join(', ');
    var outName = 'q' + (++counter) + '.json';
    var out = await Gdal.ogr2ogr(ds, ['-f', 'GeoJSON', '-dialect', 'OGRSQL',
      '-sql', 'SELECT ' + sel + ' FROM ' + quote(layer)].concat(extra || []), outName);
    var bytes = await Gdal.getFileBytes(out);
    var text = new TextDecoder('utf-8').decode(bytes);
    try { await Gdal.close(out); } catch (e) { /* تجاهل */ }
    return JSON.parse(text);
  }

  function isPlainPoint(t) { return /^\s*(3d\s+)?point/i.test(t) && !/multi/i.test(t); }
  function pickField(layer, wanted) {
    if (!wanted) return null;
    var up = wanted.toUpperCase();
    for (var i = 0; i < layer.fields.length; i++) if (layer.fields[i].toUpperCase() === up) return layer.fields[i];
    return null;
  }

  /** يجهّز مدخلات محرك الفحص من الـ dataset */
  async function readForQA(Gdal, ds, network, onProgress) {
    var cfg = QA.NETWORKS[network];
    onProgress = onProgress || function () {};
    var layers = await layerInfo(Gdal, ds);
    var byUpper = {};
    layers.forEach(function (l) { byUpper[l.name.toUpperCase()] = l; });
    var warnings = [];

    var lineTargets = [{ role: 'mainline', name: cfg.mainline }, { role: 'lateral', name: cfg.lateral }];
    if (!lineTargets.some(function (t) { return byUpper[t.name.toUpperCase()]; })) {
      var other = Object.keys(QA.NETWORKS).map(function (k) { return QA.NETWORKS[k]; })
        .filter(function (n) { return n.key !== cfg.key && byUpper[n.mainline.toUpperCase()]; })[0];
      if (other) throw userError('الملف فيه طبقات ' + other.label + ' (' + other.mainline + ') مش ' + cfg.label + '. اختار نوع الشبكة الصح وحاول تاني.');
      throw userError('لم يتم العثور على طبقات الخطوط المطلوبة (' + cfg.mainline + '، ' + cfg.lateral + '). الطبقات الموجودة: ' +
        layers.slice(0, 30).map(function (l) { return l.name; }).join('، '));
    }

    // ---- طبقات النقاط
    var allPoints = layers.filter(function (l) { return isPlainPoint(l.type); });
    var chosen = allPoints.filter(function (l) { return l.name.toUpperCase().indexOf(cfg.pointPrefix.toUpperCase()) === 0; });
    if (!chosen.length && allPoints.length) {
      chosen = allPoints;
      warnings.push('لم يتم العثور على طبقات نقاط تبدأ بـ ' + cfg.pointPrefix + ' فتم استخدام كل طبقات النقاط.');
    }
    if (!chosen.length) throw userError('لا توجد أي طبقة نقاط في الملف المرفوع.');

    var points = [], pointLayers = [], layerMeta = [];
    for (var i = 0; i < chosen.length; i++) {
      var pl = chosen[i];
      onProgress(0.08 + 0.3 * i / chosen.length, 'جاري قراءة النقاط: ' + pl.name);
      var fG = pickField(pl, QA.POINT_GROUND_FIELD), fI = pickField(pl, QA.POINT_INVERT_FIELD), fH = pickField(pl, cfg.highInvertField);
      var gj;
      try { gj = await exportGeoJSON(Gdal, ds, pl.name, [fG, fI, fH].filter(Boolean)); }
      catch (e) { warnings.push('تعذر قراءة الطبقة ' + pl.name); continue; }
      gj.features.forEach(function (f) {
        var g = f.geometry;
        if (!g || !g.coordinates || !g.coordinates.length) return;
        var p = f.properties || {};
        points.push({ fc: pl.name, oid: p.__OID__, x: g.coordinates[0], y: g.coordinates[1],
          ground: fG ? clean(p[fG]) : null, invert: fI ? clean(p[fI]) : null, high: fH ? clean(p[fH]) : null });
      });
      pointLayers.push(pl.name);
      layerMeta.push({ fc: pl.name, kind: 'point', fields: [fG, fI, fH].filter(Boolean) });
    }
    if (!points.length) throw userError('طبقات النقاط فاضية.');

    // ---- طبقات الخطوط
    var lines = [], crsWkt = null;
    for (var k = 0; k < lineTargets.length; k++) {
      var t = lineTargets[k], L = byUpper[t.name.toUpperCase()];
      if (!L) { warnings.push('لم يتم العثور على طبقة ' + t.name); continue; }
      onProgress(0.4 + 0.15 * k, 'جاري قراءة الخطوط: ' + L.name);
      var fm = {}, missing = [];
      Object.keys(QA.LINE_FIELDS).forEach(function (key) {
        var real = pickField(L, QA.LINE_FIELDS[key]);
        if (!real) missing.push(QA.LINE_FIELDS[key]); else fm[key] = real;
      });
      if (missing.length) throw userError('الطبقة ' + L.name + ' ناقصها الحقول: ' + missing.join('، '));
      if (!crsWkt) crsWkt = L.wkt;
      // حقل حالة الأصول (اختياري): مطلوب فقط لقواعد الخط الفرعي المتقدمة في الصرف الصحي
      var assetField = (t.role === 'lateral' && cfg.assetStatusField) ? pickField(L, cfg.assetStatusField) : null;
      var selectFields = Object.keys(fm).map(function (x) { return fm[x]; }).concat(assetField ? [assetField] : []);
      var lg = await exportGeoJSON(Gdal, ds, L.name, selectFields);
      var feats = lg.features.map(function (f) {
        var p = f.properties || {};
        return { oid: p.__OID__, geometry: f.geometry, sg: clean(p[fm.sg]), si: clean(p[fm.si]), eg: clean(p[fm.eg]), ei: clean(p[fm.ei]),
          assetStatus: assetField ? p[assetField] : null };
      });
      lines.push({ role: t.role, fc: L.name, features: feats });
      layerMeta.push({ fc: L.name, kind: 'line', role: t.role, fields: Object.keys(fm).map(function (x) { return fm[x]; }) });
    }

    if (crsWkt && /^\s*GEOG(CRS|CS)/i.test(crsWkt)) {
      throw userError('النظام الإحداثي جغرافي (درجات). لازم يكون مسقّط بالمتر (مثل UTM) عشان مسافات الفحص تشتغل صح.');
    }
    if (!crsWkt) warnings.push('النظام الإحداثي غير معرّف؛ تم افتراض أن الوحدة بالمتر.');

    return { input: { network: network, points: points, lines: lines }, warnings: warnings, crsWkt: crsWkt, pointLayers: pointLayers, layerMeta: layerMeta };
  }

  /** طبقة كاملة (هندسة + الحقول المهمة) بإحداثيات WGS84 لعرضها على الخريطة */
  async function readLayerWgs84(Gdal, ds, layerName, fieldNames) {
    var gj = await exportGeoJSON(Gdal, ds, layerName, fieldNames || [],
      ['-t_srs', 'EPSG:4326', '-lco', 'COORDINATE_PRECISION=6']);
    gj.features.forEach(function (f) {
      var p = f.properties || {};
      Object.keys(p).forEach(function (k) {
        if (k !== '__OID__' && typeof p[k] === 'number') p[k] = clean(p[k]);
      });
    });
    return gj.features.filter(function (f) { return f.geometry; });
  }

  return { openDataset: openDataset, readForQA: readForQA, readLayerWgs84: readLayerWgs84,
           listZipEntries: listZipEntries, userError: userError };
});
