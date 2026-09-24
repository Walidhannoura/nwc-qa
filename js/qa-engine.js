/* محرك فحص جودة بيانات شبكات المياه والصرف الصحي (JavaScript)
 * نفس منطق سكريبتات arcpy (water_QA / wastewater_QA):
 *   1) Geometric : طرفا كل خط لازم يقعوا على نقطة (في حدود XY_TOLERANCE)
 *   2) Attribute : مناسيب الأرض والإنفرت لازم تطابق مناسيب النقطة المربوطة
 *   الصرف الصحي (الخطوط الفرعية): إنفرت النهاية مش أقل من النقطة + الميل صحيح
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QAEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var XY_TOLERANCE = 0.00000001;    // مسافة اعتبار الطرف "مربوط" بالنقطة (بالمتر)
  var NEAR_MISS_SEARCH_DIST = 1.0;  // أقصى مسافة للبحث عن أقرب نقطة لطرف غير مربوط
  var ELEV_TOLERANCE = 0.00000001;  // أقصى فرق بين قيمتين يُعتبران معاه متطابقين

  var LINE_FIELDS = {
    sg: 'STARTPIPEGROUNDELEVATION', si: 'STARTPIPEELEVATION',
    eg: 'ENDPIPEGROUNDELEVATION', ei: 'ENDPIPEELEVATION'
  };
  var POINT_GROUND_FIELD = 'GROUNDELEVATION';
  var POINT_INVERT_FIELD = 'ELEVATION';

  var NETWORKS = {
    water: {
      key: 'water', label: 'شبكة المياه',
      mainline: 'W_MAINLINE', lateral: 'W_LATERALLINE',
      pointPrefix: 'W_', highInvertField: null,
      mainlineRules: 'match', lateralRules: 'match', reportMissingPoint: true,
      invertWord: 'إنفرت', danglingNear: 'غير مربوط ربطًا تامًا بنقطة'
    },
    wastewater: {
      key: 'wastewater', label: 'شبكة الصرف الصحي',
      mainline: 'WW_MAINLINE', lateral: 'WW_LATERALLINE',
      pointPrefix: 'WW_', highInvertField: 'HIGHPIPEELEVATION',
      mainlineRules: 'match', lateralRules: 'gravity', reportMissingPoint: false,
      invertWord: 'انفرت', danglingNear: 'ملامس لنقطة لكن غير مطابق تمامًا',
      // قواعد الخط الفرعي: لو الحالة Proposed لازم تطابق تام زي المين لاين،
      // ولو مش Proposed ومتصل بمنهول يُسمح بمساوٍ أو أعلى، وأي اتصال تاني (واي..) لازم تطابق تام
      assetStatusField: 'ASSETSTATUS', proposedValues: ['proposed'], manholeLayers: ['WW_MANHOLE']
    }
  };

  // ---------------------------------------------------------------- helpers
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var x = typeof v === 'number' ? v : parseFloat(v);
    return isNaN(x) ? null : x;
  }
  // تنسيق الأرقام زي بايثون (12 -> 12.0) عشان التقارير تطابق النسخة الأصلية
  function pf(v) {
    if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return 'None';
    return Number.isInteger(v) ? v.toFixed(1) : String(v);
  }
  function pl(arr) { return '[' + arr.map(pf).join(', ') + ']'; }

  function valuesMatch(v1, v2) {
    var a = num(v1);
    if (a === null) return false;
    var list = Array.isArray(v2) ? v2 : [v2];
    for (var i = 0; i < list.length; i++) {
      var c = num(list[i]);
      if (c !== null && Math.abs(a - c) <= ELEV_TOLERANCE) return true;
    }
    return false;
  }

  function lineEndpoints(g) {
    if (!g || !g.coordinates) return null;
    var c = g.coordinates, first, last;
    if (g.type === 'LineString') {
      if (!c.length) return null;
      first = c[0]; last = c[c.length - 1];
    } else if (g.type === 'MultiLineString') {
      var parts = c.filter(function (p) { return p && p.length; });
      if (!parts.length) return null;
      first = parts[0][0]; last = parts[parts.length - 1][parts[parts.length - 1].length - 1];
    } else return null;
    return [first[0], first[1], last[0], last[1]];
  }

  var OFFSET = 33554432, MULT = 67108864;   // 2^25 , 2^26
  function cellKey(ix, iy) { return (ix + OFFSET) * MULT + (iy + OFFSET); }

  function buildGrid(points) {
    var grid = new Map();
    for (var i = 0; i < points.length; i++) {
      var k = cellKey(Math.floor(points[i].x), Math.floor(points[i].y));
      var arr = grid.get(k);
      if (arr) arr.push(i); else grid.set(k, [i]);
    }
    return grid;
  }

  function locate(points, grid, x, y) {
    var cx = Math.floor(x), cy = Math.floor(y);
    var exact = -1, near = -1, nd = Infinity;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        var list = grid.get(cellKey(cx + dx, cy + dy));
        if (!list) continue;
        for (var j = 0; j < list.length; j++) {
          var idx = list[j], p = points[idx];
          var d = Math.hypot(p.x - x, p.y - y);
          if (d <= XY_TOLERANCE && (exact < 0 || idx < exact)) exact = idx;
          if (d <= NEAR_MISS_SEARCH_DIST && (d < nd || (d === nd && idx < near))) { nd = d; near = idx; }
        }
      }
    }
    return { exact: exact, near: near, nd: nd };
  }

  function pointRec(points, i) {
    if (i < 0) return null;
    var p = points[i], inverts = [];
    if (p.invert !== null && p.invert !== undefined) inverts.push(p.invert);
    if (p.high !== null && p.high !== undefined) inverts.push(p.high);
    return { fc: p.fc, oid: p.oid, ground: p.ground === undefined ? null : p.ground, inverts: inverts };
  }

  // ---------------------------------------------------------- قواعد المناسيب
  function checkMatch(add, a, sp, ep, reportMissing, invertWord) {
    var sides = [
      ['البداية', a.sg, a.si, sp],
      ['النهاية', a.eg, a.ei, ep]
    ];
    sides.forEach(function (s) {
      var label = s[0], g = s[1], inv = s[2], p = s[3];
      if (!p) {
        if (reportMissing) add('Attribute', 'تعذر فحص مناسيب ' + label + ' - لا توجد نقطة مربوطة', '');
        return;
      }
      if (!valuesMatch(g, p.ground)) {
        add('Attribute', 'منسوب أرض ' + label + ' غير مطابق لنقطة ' + label,
          'خط=' + pf(num(g)) + ' | نقطة(' + p.fc + ')=' + pf(p.ground));
      }
      if (!valuesMatch(inv, p.inverts)) {
        add('Attribute', 'منسوب ' + invertWord + ' ' + label + ' غير مطابق لنقطة ' + label,
          'خط=' + pf(num(inv)) + ' | مناسيب نقطة(' + p.fc + ')=' + pl(p.inverts));
      }
    });
  }

  // قواعد الخط الفرعي (Lateral) للصرف الصحي:
  //  - Proposed: البداية والنهاية لازم تتطابق تمامًا مع منسوب النقطة (زي المين لاين)،
  //    سواء كانت النهاية متصلة بواي أو بمنهول.
  //  - غير ذلك: البداية تتطابق تمامًا دايمًا. النهاية: لو متصلة بمنهول يُسمح
  //    بمساوٍ أو أعلى (خطأ فقط لو أقل)، ولو متصلة بأي حاجة تانية لازم تطابق تام.
  function isProposed(status, proposedValues) {
    var s = (status === null || status === undefined ? '' : String(status)).trim().toLowerCase();
    return (proposedValues || []).indexOf(s) >= 0;
  }

  function checkLateralElevations(add, a, sp, ep, cfg) {
    var proposed = isProposed(a.assetStatus, cfg.proposedValues);
    var iw = cfg.invertWord;

    if (sp) {
      if (!valuesMatch(a.sg, sp.ground)) {
        add('Attribute', 'منسوب أرض البداية غير مطابق لنقطة البداية',
          'خط=' + pf(num(a.sg)) + ' | نقطة(' + sp.fc + ')=' + pf(sp.ground));
      }
      if (!valuesMatch(a.si, sp.inverts)) {
        add('Attribute', 'منسوب ' + iw + ' البداية غير مطابق لنقطة البداية',
          'خط=' + pf(num(a.si)) + ' | مناسيب النقطة(' + sp.fc + ')=' + pl(sp.inverts));
      }
    }
    if (!ep) return;

    if (!valuesMatch(a.eg, ep.ground)) {
      add('Attribute', 'منسوب أرض النهاية غير مطابق لنقطة النهاية',
        'خط=' + pf(num(a.eg)) + ' | نقطة(' + ep.fc + ')=' + pf(ep.ground));
    }

    var eInv = num(a.ei), sInv = num(a.si), ptInv = ep.inverts;
    var endOnManhole = (cfg.manholeLayers || []).indexOf(ep.fc) >= 0;
    var allowEqualOrHigher = !proposed && endOnManhole;

    if (eInv === null || !ptInv.length) {
      add('Attribute', 'قيمة منسوب مفقودة لمقارنة ' + iw + ' النهاية بالنقطة',
        iw + ' النهاية=' + pf(eInv) + ' | منسوب النقطة=' + pl(ptInv));
    } else if (allowEqualOrHigher) {
      var mn = Math.min.apply(null, ptInv);
      if (eInv < mn - ELEV_TOLERANCE) {
        var diff = eInv - mn;
        add('Attribute', 'منسوب ' + iw + ' النهاية أقل من منسوب المنهول',
          iw + ' النهاية=' + pf(eInv) + ' | منسوب المنهول(' + ep.fc + ')=' + pl(ptInv) +
          ' | الفرق=' + diff.toFixed(3) + ' م');
      }
    } else if (!valuesMatch(eInv, ptInv)) {
      add('Attribute', 'منسوب ' + iw + ' النهاية غير مطابق لمنسوب نقطة النهاية',
        iw + ' النهاية=' + pf(eInv) + ' | مناسيب النقطة(' + ep.fc + ')=' + pl(ptInv));
    }

    if (eInv !== null && sInv !== null && eInv >= sInv - ELEV_TOLERANCE) {
      add('Attribute', iw + ' النهاية غير أقل من ' + iw + ' البداية (خطأ في الميل)',
        iw + ' البداية=' + pf(sInv) + ' | ' + iw + ' النهاية=' + pf(eInv));
    }
  }

  // ------------------------------------------------------------- التشغيل
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /**
   * input = {
   *   network: 'water'|'wastewater',
   *   points: [{fc, oid, x, y, ground, invert, high}],
   *   lines:  [{role:'mainline'|'lateral', fc, features:[{oid, geometry, sg, si, eg, ei}]}]
   * }
   */
  async function run(input, onProgress) {
    var cfg = NETWORKS[input.network];
    if (!cfg) throw new Error('نوع الشبكة غير معروف.');
    onProgress = onProgress || function () {};
    var points = input.points, grid = buildGrid(points);
    var errors = [], linesChecked = {};
    var totalFeatures = input.lines.reduce(function (s, l) { return s + l.features.length; }, 0) || 1;
    var done = 0;

    for (var li = 0; li < input.lines.length; li++) {
      var layer = input.lines[li];
      var rules = layer.role === 'mainline' ? cfg.mainlineRules : cfg.lateralRules;
      var feats = layer.features;
      for (var i = 0; i < feats.length; i++) {
        var f = feats[i];
        (function (f) {
          var add = function (cat, type, details) {
            errors.push({ fc: layer.fc, oid: f.oid, category: cat, type: type, details: details, geom: f.geometry || null });
          };
          var ends = lineEndpoints(f.geometry);
          if (!ends) { add('Geometric', 'جيومترى الخط فارغة أو تالفة', ''); return; }
          var res = [locate(points, grid, ends[0], ends[1]), locate(points, grid, ends[2], ends[3])];
          ['البداية', 'النهاية'].forEach(function (label, k) {
            var r = res[k];
            if (r.exact >= 0) return;
            if (r.near >= 0) {
              add('Geometric', 'طرف الخط (' + label + ') ' + cfg.danglingNear + ' (Dangling)',
                'أقرب نقطة: ' + points[r.near].fc + ' (OID=' + points[r.near].oid + ') على بعد ' + r.nd.toFixed(3) + ' م');
            } else {
              add('Geometric', 'طرف الخط (' + label + ') غير متصل بأي نقطة إطلاقًا (Free Dangling End)',
                'لا توجد نقطة قريبة في حدود ' + pf(NEAR_MISS_SEARCH_DIST) + ' م');
            }
          });
          var sp = pointRec(points, res[0].exact), ep = pointRec(points, res[1].exact);
          if (rules === 'gravity') checkLateralElevations(add, f, sp, ep, cfg);
          else checkMatch(add, f, sp, ep, cfg.reportMissingPoint, cfg.invertWord);
        })(f);
        done++;
        if (done % 4000 === 0) { onProgress(0.55 + 0.4 * done / totalFeatures, 'جاري فحص ' + layer.fc + '...'); await tick(); }
      }
      linesChecked[layer.fc] = feats.length;
    }
    return { network: input.network, errors: errors, linesChecked: linesChecked, pointsIndexed: points.length };
  }

  // -------------------------------------------------------------- ملخصات
  function buildSummary(result) {
    var byKey = new Map(), lines = new Set(), byLayer = {};
    Object.keys(result.linesChecked).forEach(function (fc) { byLayer[fc] = 0; });
    result.errors.forEach(function (e) {
      var k = e.category + '\u0000' + e.type;
      var cur = byKey.get(k);
      if (cur) cur.count++; else byKey.set(k, { category: e.category, type: e.type, count: 1 });
      lines.add(e.fc + '\u0000' + e.oid);
      byLayer[e.fc] = (byLayer[e.fc] || 0) + 1;
    });
    var byType = Array.from(byKey.values()).sort(function (a, b) { return b.count - a.count; });
    return {
      network: result.network, total_errors: result.errors.length, lines_with_errors: lines.size,
      lines_checked: result.linesChecked, errors_by_layer: byLayer, by_type: byType,
      points_indexed: result.pointsIndexed
    };
  }

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(errors) {
    var rows = ['FeatureClass,OID,ErrorCategory,ErrorType,Details'];
    errors.forEach(function (e) {
      rows.push([e.fc, e.oid, e.category, e.type, e.details].map(csvCell).join(','));
    });
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }

  return {
    NETWORKS: NETWORKS, LINE_FIELDS: LINE_FIELDS,
    POINT_GROUND_FIELD: POINT_GROUND_FIELD, POINT_INVERT_FIELD: POINT_INVERT_FIELD,
    XY_TOLERANCE: XY_TOLERANCE, NEAR_MISS_SEARCH_DIST: NEAR_MISS_SEARCH_DIST,
    num: num, run: run, buildSummary: buildSummary, toCSV: toCSV
  };
});
