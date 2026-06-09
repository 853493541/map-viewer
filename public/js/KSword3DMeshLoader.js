/**
 * KSword3DMeshLoader - Direct .mesh file loader for Three.js.
 * Parses KSword3D binary .mesh files and creates BufferGeometry.
 *
 * Preserves ALL original vertex data: positions, normals, tangents,
 * UV1, UV2, UV3, vertex colors. No recomputation, no GLB intermediate.
 *
 * Usage:
 *   const loader = new KSword3DMeshLoader();
 *   const geometry = await loader.loadAsync('path/to/file.mesh');
 */

import * as THREE from 'three';

export class KSword3DMeshLoader extends THREE.Loader {
  constructor(manager) {
    super(manager);
  }

  load(url, onLoad, onProgress, onError) {
    const scope = this;
    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType('arraybuffer');
    loader.setRequestHeader(this.requestHeader);
    loader.setPath(this.path);
    loader.setWithCredentials(this.withCredentials);

    loader.load(url, function (buffer) {
      try {
        const result = scope.parse(buffer);
        if (onLoad) onLoad(result);
      } catch (e) {
        if (onError) onError(e);
        else console.error('KSword3DMeshLoader:', e);
      }
    }, onProgress, onError);
  }

  async loadAsync(url, onProgress) {
    const scope = this;
    const loader = new THREE.FileLoader(this.manager);
    loader.setResponseType('arraybuffer');
    loader.setRequestHeader(this.requestHeader);
    loader.setPath(this.path);
    loader.setWithCredentials(this.withCredentials);

    const buffer = await loader.loadAsync(url, onProgress);
    return scope.parse(buffer);
  }

  /**
   * Parse a KSword3D .mesh file array buffer.
   * Returns { geometries: [{ geometry, subsetId }], vertexCount, triangleCount, numSubsets, subsetIds }
   */
  parse(buffer) {
    const data = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (data.length < 0x114) throw new Error(`File too small: ${data.length} bytes`);

    const meshMagic = dv.getUint32(0x54, true);
    if (meshMagic !== 0x4D455348) throw new Error(`Invalid mesh magic: 0x${meshMagic.toString(16)}`);

    const vertexCount = dv.getUint32(0x90, true);
    const triangleCount = dv.getUint32(0x94, true);
    const numSubsets = dv.getUint32(0x98, true);

    const offPosition = dv.getUint32(0x9C, true);
    const offNormal   = dv.getUint32(0xA0, true);
    const offDiffuse  = dv.getUint32(0xA4, true);
    const offUV1      = dv.getUint32(0xA8, true);
    const offUV2      = dv.getUint32(0xAC, true);
    const offUV3      = dv.getUint32(0xB0, true);
    const offFaces    = dv.getUint32(0xB4, true);
    const offSubsets  = dv.getUint32(0xB8, true);
    const offSkin     = dv.getUint32(0xBC, true);
    const offTangent  = dv.getUint32(0xD0, true);

    const allBlockOffsets = [...new Set(
      [offPosition, offNormal, offDiffuse, offUV1, offUV2, offUV3,
       offFaces, offSubsets, offSkin, offTangent].filter(v => v !== 0)
    )].sort((a, b) => a - b);
    allBlockOffsets.push(data.length);

    function blockSize(offset) {
      if (offset === 0) return 0;
      const idx = allBlockOffsets.indexOf(offset);
      return idx + 1 < allBlockOffsets.length ? allBlockOffsets[idx + 1] - offset : 0;
    }

    const posSz = blockSize(offPosition);
    const normSz = blockSize(offNormal);
    const uv1Sz = blockSize(offUV1);
    const tanSz = blockSize(offTangent);
    const subSz = blockSize(offSubsets);

    const posBpv = vertexCount > 0 ? posSz / vertexCount : 0;
    const normBpv = vertexCount > 0 ? normSz / vertexCount : 0;
    const uv1Bpv = vertexCount > 0 ? uv1Sz / vertexCount : 0;
    const tanBpv = vertexCount > 0 ? tanSz / vertexCount : 0;
    const subBpf = triangleCount > 0 ? subSz / triangleCount : 0;

    let posCompressed = offPosition ? (Math.abs(posSz - (24 + vertexCount * 6)) <= 4) : false;
    if (!posCompressed && offPosition) posCompressed = posBpv < 8.0 && posBpv > 4.0;

    const normCompressed = offNormal ? normBpv < 5.0 : false;
    const normQTangent = offNormal ? normBpv >= 6.5 && normBpv < 9.0 : false;
    const uv1Compressed = offUV1 ? uv1Bpv < 8.0 : false;
    const tanCompressed = offTangent ? tanBpv < 8.0 : false;
    const subIsU16 = offSubsets ? subBpf < 3.0 : false;

    // Build geometry arrays
    let positions = null, normals = null, tangents = null, uvs = null;
    let uvs2 = null, uvs3 = null, colors = null, indices = null, subsetIds = null;

    // --- POSITIONS ---
    if (offPosition) {
      const pa = new Float32Array(vertexCount * 3);
      if (posCompressed) {
        let mnx = Infinity, mny = Infinity, mnz = Infinity;
        let mxx = -Infinity, myy = -Infinity, mzz = -Infinity;
        for (let i = 0; i < 6; i++) {
          const v = dv.getFloat32(offPosition + i * 4, true);
          if (i < 3) { if (v < [mnx,mny,mnz][i]) [mnx,mny,mnz][i] = v; if (v > [mxx,myy,mzz][i]) [mxx,myy,mzz][i] = v; }
          else { const j = i - 3; if (v < [mnx,mny,mnz][j]) [mnx,mny,mnz][j] = v; if (v > [mxx,myy,mzz][j]) [mxx,myy,mzz][j] = v; }
        }
        // Redo properly
        const bbox = [];
        for (let i = 0; i < 6; i++) bbox.push(dv.getFloat32(offPosition + i * 4, true));
        const ctr = [
          (Math.min(bbox[0], bbox[3]) + Math.max(bbox[0], bbox[3])) / 2,
          (Math.min(bbox[1], bbox[4]) + Math.max(bbox[1], bbox[4])) / 2,
          (Math.min(bbox[2], bbox[5]) + Math.max(bbox[2], bbox[5])) / 2,
        ];
        const half = [
          Math.abs(bbox[3] - bbox[0]) / 2,
          Math.abs(bbox[4] - bbox[1]) / 2,
          Math.abs(bbox[5] - bbox[2]) / 2,
        ];
        const vdata = offPosition + 24;
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = vdata + vi * 6;
          const sx = dv.getInt16(o, true);
          const sy = dv.getInt16(o + 2, true);
          const sz = dv.getInt16(o + 4, true);
          pa[vi * 3] = ctr[0] + (sx / 32767) * half[0];
          pa[vi * 3 + 1] = ctr[1] + (sy / 32767) * half[1];
          pa[vi * 3 + 2] = ctr[2] + (sz / 32767) * half[2];
        }
      } else {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offPosition + vi * 12;
          pa[vi * 3] = dv.getFloat32(o, true);
          pa[vi * 3 + 1] = dv.getFloat32(o + 4, true);
          pa[vi * 3 + 2] = dv.getFloat32(o + 8, true);
        }
      }
      positions = pa;
    }

    // --- NORMALS (keep original, no recomputation!) ---
    if (offNormal && vertexCount > 0) {
      const na = new Float32Array(vertexCount * 3);
      if (normQTangent) {
        const stride = Math.round(normBpv);
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offNormal + vi * stride;
          const qx = dv.getInt8(o);
          const qy = dv.getInt8(o + 1);
          const qz = dv.getInt8(o + 2);
          const qw = dv.getInt8(o + 3);
          let fqx = qx / 127, fqy = qy / 127, fqz = qz / 127, fqw = qw / 127;
          const mag = Math.sqrt(fqx * fqx + fqy * fqy + fqz * fqz + fqw * fqw);
          if (mag > 0.0001) { fqx /= mag; fqy /= mag; fqz /= mag; fqw /= mag; }
          na[vi * 3] = 2 * (fqx * fqz + fqw * fqy);
          na[vi * 3 + 1] = 2 * (fqy * fqz - fqw * fqx);
          na[vi * 3 + 2] = 1 - 2 * (fqx * fqx + fqy * fqy);
        }
      } else if (normCompressed) {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offNormal + vi * 3;
          let nx = dv.getInt8(o) / 127;
          let ny = dv.getInt8(o + 1) / 127;
          let nz = dv.getInt8(o + 2) / 127;
          const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (mag > 0.0001) { nx /= mag; ny /= mag; nz /= mag; }
          else { nx = 0; ny = 0; nz = 1; }
          na[vi * 3] = nx;
          na[vi * 3 + 1] = ny;
          na[vi * 3 + 2] = nz;
        }
      } else {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offNormal + vi * 12;
          let nx = dv.getFloat32(o, true);
          let ny = dv.getFloat32(o + 4, true);
          let nz = dv.getFloat32(o + 8, true);
          if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) { nx = 0; ny = 0; nz = 1; }
          else {
            const mag = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (mag > 0.0001) { nx /= mag; ny /= mag; nz /= mag; }
            else { nx = 0; ny = 0; nz = 1; }
          }
          na[vi * 3] = nx;
          na[vi * 3 + 1] = ny;
          na[vi * 3 + 2] = nz;
        }
      }
      normals = na;
    }

    // --- TANGENTS ---
    if (offTangent && vertexCount > 0) {
      const ta = new Float32Array(vertexCount * 4);
      if (tanCompressed) {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offTangent + vi * 4;
          let tx = dv.getInt8(o) / 127;
          let ty = dv.getInt8(o + 1) / 127;
          let tz = dv.getInt8(o + 2) / 127;
          const b3 = data[o + 3];
          const mag = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (mag > 0.0001) { tx /= mag; ty /= mag; tz /= mag; }
          else { tx = 1; ty = 0; tz = 0; }
          ta[vi * 4] = tx;
          ta[vi * 4 + 1] = ty;
          ta[vi * 4 + 2] = tz;
          ta[vi * 4 + 3] = b3 < 128 ? 1 : -1;
        }
      } else {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offTangent + vi * 16;
          let tx = dv.getFloat32(o, true);
          let ty = dv.getFloat32(o + 4, true);
          let tz = dv.getFloat32(o + 8, true);
          let tw = dv.getFloat32(o + 12, true);
          if (!isFinite(tx) || !isFinite(ty) || !isFinite(tz)) { tx = 1; ty = 0; tz = 0; tw = 1; }
          else {
            const mag = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (mag > 0.0001) { tx /= mag; ty /= mag; tz /= mag; }
            else { tx = 1; ty = 0; tz = 0; }
          }
          ta[vi * 4] = tx;
          ta[vi * 4 + 1] = ty;
          ta[vi * 4 + 2] = tz;
          ta[vi * 4 + 3] = tw >= 0 ? 1 : -1;
        }
      }
      tangents = ta;
    }

    // --- UV1 ---
    if (offUV1 && vertexCount > 0) {
      const ua = new Float32Array(vertexCount * 2);
      if (uv1Compressed) {
        const uScale = dv.getFloat32(offUV1, true);
        const vScale = dv.getFloat32(offUV1 + 4, true);
        const wScale = dv.getFloat32(offUV1 + 8, true);
        const uvDataStart = offUV1 + 12;
        const isAddMode = (Math.abs(uScale - 1) < 0.05 && Math.abs(vScale - 1) < 0.05);
        const hasWDiv = Math.abs(wScale) > 0.001;
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = uvDataStart + vi * 6;
          const uRaw = dv.getInt16(o, true);
          const vRaw = dv.getInt16(o + 2, true);
          const uNorm = uRaw / 32767;
          const vNorm = vRaw / 32767;
          if (hasWDiv) {
            ua[vi * 2] = uNorm * uScale / wScale;
            ua[vi * 2 + 1] = vNorm * vScale / wScale;
          } else if (isAddMode) {
            ua[vi * 2] = uNorm + uScale;
            ua[vi * 2 + 1] = vNorm + vScale;
          } else {
            ua[vi * 2] = uNorm * uScale;
            ua[vi * 2 + 1] = vNorm * vScale;
          }
        }
      } else {
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offUV1 + vi * 12;
          ua[vi * 2] = dv.getFloat32(o, true);
          ua[vi * 2 + 1] = dv.getFloat32(o + 4, true);
        }
      }
      uvs = ua;
    }

    // --- UV2 ---
    if (offUV2 && vertexCount > 0) {
      const uv2Sz = blockSize(offUV2);
      if (uv2Sz >= vertexCount * 8) {
        const uv2Bpv = uv2Sz / vertexCount;
        const uv2Compressed = uv2Bpv < 8;
        const stride = Math.round(uv2Bpv);
        if (uv2Compressed && uv2Sz >= 12 + vertexCount * 6) {
          const ua2 = new Float32Array(vertexCount * 2);
          const uScale2 = dv.getFloat32(offUV2, true);
          const vScale2 = dv.getFloat32(offUV2 + 4, true);
          const uv2DataStart = offUV2 + 12;
          for (let vi = 0; vi < vertexCount; vi++) {
            const o = uv2DataStart + vi * 6;
            ua2[vi * 2] = (dv.getInt16(o, true) / 32767) * uScale2;
            ua2[vi * 2 + 1] = (dv.getInt16(o + 2, true) / 32767) * vScale2;
          }
          uvs2 = ua2;
        } else if (stride >= 8 && uv2Sz >= vertexCount * stride) {
          const ua2 = new Float32Array(vertexCount * 2);
          for (let vi = 0; vi < vertexCount; vi++) {
            const o = offUV2 + vi * stride;
            if (o + 8 <= data.length) {
              ua2[vi * 2] = dv.getFloat32(o, true);
              ua2[vi * 2 + 1] = dv.getFloat32(o + 4, true);
            }
          }
          uvs2 = ua2;
        }
      }
    }

    // --- UV3 ---
    if (offUV3 && vertexCount > 0) {
      const uv3Sz = blockSize(offUV3);
      const uv3Bpv = uv3Sz / vertexCount;
      const stride3 = Math.round(uv3Bpv);
      if (uv3Sz >= vertexCount * stride3 && stride3 >= 8) {
        const ua3 = new Float32Array(vertexCount * 2);
        for (let vi = 0; vi < vertexCount; vi++) {
          const o = offUV3 + vi * stride3;
          if (o + 8 <= data.length) {
            ua3[vi * 2] = dv.getFloat32(o, true);
            ua3[vi * 2 + 1] = dv.getFloat32(o + 4, true);
          }
        }
        uvs3 = ua3;
      }
    }

    // --- VERTEX COLORS (ARGB format) ---
    if (offDiffuse && vertexCount > 0) {
      const diffBlockSz = blockSize(offDiffuse);
      let diffStride = Math.round(diffBlockSz / vertexCount);
      if (diffStride < 4) diffStride = 4;
      const ca = new Float32Array(vertexCount * 4);
      for (let vi = 0; vi < vertexCount; vi++) {
        const o = offDiffuse + vi * diffStride;
        const argb = dv.getUint32(o, true);
        ca[vi * 4] = ((argb >> 16) & 0xFF) / 255;
        ca[vi * 4 + 1] = ((argb >> 8) & 0xFF) / 255;
        ca[vi * 4 + 2] = (argb & 0xFF) / 255;
        ca[vi * 4 + 3] = ((argb >> 24) & 0xFF) / 255;
      }
      colors = ca;
    }

    // --- FACES ---
    if (offFaces && triangleCount > 0) {
      indices = new Uint32Array(triangleCount * 3);
      for (let fi = 0; fi < triangleCount * 3; fi++) {
        indices[fi] = dv.getUint32(offFaces + fi * 4, true);
      }
    }

    // --- SUBSETS ---
    if (offSubsets && numSubsets > 0 && triangleCount > 0) {
      subsetIds = new Uint16Array(triangleCount);
      for (let fi = 0; fi < triangleCount; fi++) {
        if (subIsU16) {
          subsetIds[fi] = Math.min(dv.getUint16(offSubsets + fi * 2, true), numSubsets - 1);
        } else {
          subsetIds[fi] = Math.min(dv.getUint32(offSubsets + fi * 4, true), numSubsets - 1);
        }
      }
    }

    // Build per-subset geometry list
    const geometries = [];

    if (subsetIds && numSubsets > 1) {
      // Multi-subset: create separate BufferGeometry per subset
      const subTriList = Array.from({ length: numSubsets }, () => []);
      for (let fi = 0; fi < triangleCount; fi++) {
        const sid = subsetIds[fi];
        subTriList[sid].push(fi);
      }

      for (let sid = 0; sid < numSubsets; sid++) {
        const triangles = subTriList[sid];
        if (triangles.length === 0) continue;

        // Build mapped vertex arrays for this subset
        const subIndices = [];
        const vertexMap = new Map(); // oldIdx -> newIdx
        const revMap = []; // newIdx -> oldIdx

        for (const fi of triangles) {
          for (let j = 0; j < 3; j++) {
            const oldIdx = indices[fi * 3 + j];
            if (!vertexMap.has(oldIdx)) {
              vertexMap.set(oldIdx, revMap.length);
              revMap.push(oldIdx);
            }
            subIndices.push(vertexMap.get(oldIdx));
          }
        }

        const newCount = revMap.length;
        const newPositions = new Float32Array(newCount * 3);
        let newNormals = null, newTangents = null, newUVs = null, newUVs2 = null, newUVs3 = null, newColors = null;

        for (let i = 0; i < newCount; i++) {
          const oldIdx = revMap[i];
          newPositions[i * 3] = positions[oldIdx * 3];
          newPositions[i * 3 + 1] = positions[oldIdx * 3 + 1];
          newPositions[i * 3 + 2] = -positions[oldIdx * 3 + 2]; // LH→RH
        }

        if (normals) {
          newNormals = new Float32Array(newCount * 3);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newNormals[i * 3] = normals[oldIdx * 3];
            newNormals[i * 3 + 1] = normals[oldIdx * 3 + 1];
            newNormals[i * 3 + 2] = -normals[oldIdx * 3 + 2]; // LH→RH
          }
        }

        if (tangents) {
          newTangents = new Float32Array(newCount * 4);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newTangents[i * 4] = tangents[oldIdx * 4];
            newTangents[i * 4 + 1] = tangents[oldIdx * 4 + 1];
            newTangents[i * 4 + 2] = -tangents[oldIdx * 4 + 2]; // LH→RH
            newTangents[i * 4 + 3] = -tangents[oldIdx * 4 + 3]; // handedness flip
          }
        }

        if (uvs) {
          newUVs = new Float32Array(newCount * 2);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newUVs[i * 2] = uvs[oldIdx * 2];
            newUVs[i * 2 + 1] = uvs[oldIdx * 2 + 1];
          }
        }

        if (uvs2) {
          newUVs2 = new Float32Array(newCount * 2);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newUVs2[i * 2] = uvs2[oldIdx * 2];
            newUVs2[i * 2 + 1] = uvs2[oldIdx * 2 + 1];
          }
        }

        if (uvs3) {
          newUVs3 = new Float32Array(newCount * 2);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newUVs3[i * 2] = uvs3[oldIdx * 2];
            newUVs3[i * 2 + 1] = uvs3[oldIdx * 2 + 1];
          }
        }

        if (colors) {
          newColors = new Float32Array(newCount * 4);
          for (let i = 0; i < newCount; i++) {
            const oldIdx = revMap[i];
            newColors[i * 4] = colors[oldIdx * 4];
            newColors[i * 4 + 1] = colors[oldIdx * 4 + 1];
            newColors[i * 4 + 2] = colors[oldIdx * 4 + 2];
            newColors[i * 4 + 3] = colors[oldIdx * 4 + 3];
          }
        }

        // Reverse winding for RH (i0,i1,i2 → i0,i2,i1)
        const finalIndices = new Uint32Array(subIndices.length);
        for (let fi = 0; fi < triangles.length; fi++) {
          finalIndices[fi * 3] = subIndices[fi * 3];
          finalIndices[fi * 3 + 1] = subIndices[fi * 3 + 2];
          finalIndices[fi * 3 + 2] = subIndices[fi * 3 + 1];
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
        if (newNormals) geom.setAttribute('normal', new THREE.BufferAttribute(newNormals, 3));
        if (newTangents) geom.setAttribute('tangent', new THREE.BufferAttribute(newTangents, 4));
        if (newUVs) geom.setAttribute('uv', new THREE.BufferAttribute(newUVs, 2));
        if (newUVs2) geom.setAttribute('uv2', new THREE.BufferAttribute(newUVs2, 2));
        if (newColors) geom.setAttribute('color', new THREE.BufferAttribute(newColors, 4));
        geom.setIndex(new THREE.BufferAttribute(finalIndices, 1));
        geom.computeBoundingSphere();

        geometries.push({ geometry: geom, subsetId: sid });
      }
    } else {
      // Single geometry
      const finalPositions = new Float32Array(vertexCount * 3);
      for (let vi = 0; vi < vertexCount; vi++) {
        finalPositions[vi * 3] = positions[vi * 3];
        finalPositions[vi * 3 + 1] = positions[vi * 3 + 1];
        finalPositions[vi * 3 + 2] = -positions[vi * 3 + 2]; // LH→RH
      }

      let finalNormals = null;
      if (normals) {
        finalNormals = new Float32Array(vertexCount * 3);
        for (let vi = 0; vi < vertexCount; vi++) {
          finalNormals[vi * 3] = normals[vi * 3];
          finalNormals[vi * 3 + 1] = normals[vi * 3 + 1];
          finalNormals[vi * 3 + 2] = -normals[vi * 3 + 2]; // LH→RH
        }
      }

      let finalTangents = null;
      if (tangents) {
        finalTangents = new Float32Array(vertexCount * 4);
        for (let vi = 0; vi < vertexCount; vi++) {
          finalTangents[vi * 4] = tangents[vi * 4];
          finalTangents[vi * 4 + 1] = tangents[vi * 4 + 1];
          finalTangents[vi * 4 + 2] = -tangents[vi * 4 + 2]; // LH→RH
          finalTangents[vi * 4 + 3] = -tangents[vi * 4 + 3]; // handedness
        }
      }

      // Reverse winding
      const finalIndices = new Uint32Array(triangleCount * 3);
      for (let fi = 0; fi < triangleCount; fi++) {
        finalIndices[fi * 3] = indices[fi * 3];
        finalIndices[fi * 3 + 1] = indices[fi * 3 + 2];
        finalIndices[fi * 3 + 2] = indices[fi * 3 + 1];
      }

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
      if (finalNormals) geom.setAttribute('normal', new THREE.BufferAttribute(finalNormals, 3));
      if (finalTangents) geom.setAttribute('tangent', new THREE.BufferAttribute(finalTangents, 4));
      if (uvs) {
        const finalUVs = new Float32Array(uvs); // UV doesn't change with coordinate system
        geom.setAttribute('uv', new THREE.BufferAttribute(finalUVs, 2));
      }
      if (uvs2) geom.setAttribute('uv2', new THREE.BufferAttribute(uvs2, 2));
      if (uvs3) geom.setAttribute('uv3', new THREE.BufferAttribute(uvs3, 2));
      if (colors) geom.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      geom.setIndex(new THREE.BufferAttribute(finalIndices, 1));
      geom.computeBoundingSphere();

      geometries.push({ geometry: geom, subsetId: 0 });
    }

    return {
      geometries,
      vertexCount,
      triangleCount,
      numSubsets,
      subsetIds,
      posCompressed,
      normCompressed,
    };
  }
}

/**
 * Parse a .JsonInspack companion file and return per-subset material info.
 */
export function parseJsonInspack(jsonText) {
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const subsets = [];
  const lods = obj.LOD || [];
  if (lods.length === 0) return subsets;

  const groups = lods[0].Group || [];
  if (groups.length === 0) return subsets;

  for (const subset of groups[0].Subset || []) {
    const info = { textures: {}, colors: {}, floats: {}, blendMode: 0, alphaRef: 128, refPath: null };

    for (const param of subset.Param || []) {
      if (param.Type === 'Texture') {
        info.textures[param.Name] = param.Value;
      } else if (param.Type === 'Color') {
        if (Array.isArray(param.Value)) info.colors[param.Name] = [...param.Value];
      } else if (param.Type === 'Float') {
        info.floats[param.Name] = Number(param.Value);
      }
    }

    const sinfo = subset.Info || {};
    if (sinfo.RefPath) info.refPath = sinfo.RefPath;

    const rs = subset.RenderState || {};
    info.blendMode = rs.BlendMode ?? 0;
    info.alphaRef = rs.AlphaRef ?? 128;

    subsets.push(info);
  }
  return subsets;
}

// Subset fallback colors
export const SUBSET_COLORS = [
  [0.82, 0.71, 0.55, 1.0],
  [0.60, 0.65, 0.58, 1.0],
  [0.75, 0.60, 0.45, 1.0],
  [0.55, 0.55, 0.65, 1.0],
  [0.70, 0.55, 0.50, 1.0],
  [0.65, 0.72, 0.60, 1.0],
  [0.80, 0.75, 0.65, 1.0],
  [0.58, 0.50, 0.55, 1.0],
];
