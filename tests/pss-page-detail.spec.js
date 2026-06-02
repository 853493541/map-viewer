import { test, expect } from '@playwright/test';

test.describe('pss.html PSS detail modal', () => {
  test('right-clicking a PSS row opens parsed PSS detail', async ({ page }) => {
    test.setTimeout(180_000);
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/pss.html', { waitUntil: 'domcontentloaded' });

    const firstPss = page.locator('#pss-list li.item').first();
    await expect(firstPss).toBeVisible({ timeout: 20_000 });
    await firstPss.click({ button: 'right' });

    const menu = page.locator('#pss-context-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Show detail' }).click();

    const modal = page.locator('#pss-detail-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#pss-detail-body')).toContainText('Decoded PSS Header / TOC', { timeout: 60_000 });
    await expect(modal.locator('#pss-detail-body')).toContainText('Parsed Emitters', { timeout: 60_000 });
    await expect(modal.locator('#pss-detail-body')).toContainText('Field Coverage Notes', { timeout: 60_000 });
    await expect(modal.locator('#pss-detail-body')).toContainText('correct absence', { timeout: 60_000 });
    await expect(modal.locator('.pss-detail-check-strip')).toBeVisible();
    const failedSections = await modal.locator('[data-pss-section-check][data-check-status="fail"]').evaluateAll((sections) => sections.map((section) => section.getAttribute('data-pss-section-check')));
    expect(failedSections, 'engine-default color modules must not be red failures').not.toContain('curves');
    await expect(modal.locator('[data-pss-section-check="curves"][data-check-status="warn"]')).toBeVisible();
    await expect(modal.locator('#pss-detail-body')).toContainText('no animated color keyframes', { timeout: 60_000 });
    await expect(modal.locator('[data-pss-section-check="emitters"][data-check-status="pass"]')).toBeVisible();
    await expect(modal.locator('summary', { hasText: '32-bit Word Table' })).toBeVisible();
    await expect(modal.locator('summary', { hasText: 'Full PSS Hex Dump' })).toBeVisible();
    await expect(modal.locator('summary', { hasText: 'PSS Debug Dump JSON' })).toBeVisible();
    await expect(modal.locator('summary', { hasText: 'Full PSS Detail JSON' })).toBeVisible();

    const detail = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红01.pss';
      const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const readableTexts = detail.detail.strings.map((row) => row.text).join('\n');
    expect(readableTexts).toMatch(/data[\\/]source[\\/]other[\\/]特效[\\/]贴图[\\/]yw_烟雾[\\/]yw_烟雾(?:05|15)\.tga/u);
    expect(detail.detail.strings.some((row) => row.category === 'pss-module' && row.text === '颜色贴图')).toBeTruthy();
    expect(readableTexts).not.toMatch(/[疊呅媚吙圚]/u);
    const dragonScaleEmitters = [21, 22].map((index) => detail.analyze.emitters.find((emitter) => emitter.type === 'sprite' && emitter.index === index));
    expect(dragonScaleEmitters.map((emitter) => emitter?.sizeCurveStatus)).toEqual(['authored', 'authored']);

    const [glowDetail, butterflyDetail] = await page.evaluate(async () => {
      const sourcePaths = [
        'data/source/Home/effect/effect_pss/GLOW_yellow_01.pss',
        'data/source/Home/effect/effect_pss/Butterfly_group_002.pss',
      ];
      return Promise.all(sourcePaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
    });
    const glowSprite = glowDetail.analyze.emitters.find((emitter) => emitter.index === 1 && emitter.type === 'sprite');
    expect(glowSprite?.sizeCurveStatus).toBe('no-module');
    expect(glowSprite?.runtimeParams?.sizeCurve).toBeUndefined();
    expect(glowSprite?.runtimeParams?.sizeCurveKeyframes).toBeUndefined();
    expect(glowSprite?.runtimeParams?.maxParticles).toBe(120);
    const butterflyTrail = butterflyDetail.analyze.emitters.find((emitter) => emitter.index === 1 && emitter.type === 'mesh');
    expect(butterflyTrail?.meshFields?.classFlags?.hasSiblingTrack).toBe(true);
    expect(butterflyTrail?.linkedTrack).toBeFalsy();
    expect(butterflyTrail?.trackBindingStatus).toBe('baked-mesh-animation');
    expect(butterflyTrail?.trackBinding).toMatchObject({
      status: 'baked-mesh-animation',
      trackEmitterCount: 0,
      resolvedMeshCount: 1,
      resolvedAnimationCount: 1,
    });

    const extraDetails = await page.evaluate(async () => {
      const sourcePaths = [
        'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红02.pss',
        'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙_狼头版.pss',
      ];
      return Promise.all(sourcePaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
    });
    const extraReadableTexts = extraDetails.flatMap((item) => item.detail.strings.map((row) => row.text));
    expect(extraReadableTexts).not.toEqual(expect.arrayContaining([
      'CPY_Cach',
      'oat4 l_TexSize',
      'rc.RCPY1i',
      '-0.3915444612503052',
      '0.9783911',
    ]));
    expect(extraReadableTexts).toContain('Microsoft (R) HLSL Shader Compiler 10.1');
    expect(extraReadableTexts).toContain('Texture2D g_Tex_1 : register( t1 )');

    const wolfHeadDetail = extraDetails[1];
    const clothVariantEmitters = wolfHeadDetail.analyze.emitters.filter((emitter) => emitter.meshFields?.launcherClassKey === '03000100');
    expect(clothVariantEmitters).toHaveLength(2);
    expect(clothVariantEmitters.map((emitter) => emitter.meshFields.launcherClass)).toEqual(['ClothVariantB', 'ClothVariantB']);
    const decodedTrackEmitter = wolfHeadDetail.analyze.emitters.find((emitter) => emitter.type === 'track' && emitter.trackParams?.radiusCandidate === 80);
    expect(decodedTrackEmitter?.trackParamsWarning).toBeNull();
    expect(decodedTrackEmitter?.trackParams).toMatchObject({
      struct: 'KG3D_PARSYS_TRACK_BLOCK',
      blockSize: 236,
      scaleXYZ: [1, 1, 1],
      uniformScale: 1,
      radiusCandidate: 80,
      segmentCountCandidate: 160,
      alpha: 0.65,
    });
    expect(decodedTrackEmitter?.trackParams?.miscParams).toHaveLength(6);
    const wolfSprite18 = wolfHeadDetail.analyze.emitters.find((emitter) => emitter.index === 18 && emitter.type === 'sprite');
    expect(wolfSprite18?.sizeCurveStatus).toBe('no-animation');
    const wolfDebugDump = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/技能/Pss/发招/T_天策龙牙_狼头版.pss';
      const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const wolfBlock18Scale = wolfDebugDump.blocks.find((block) => block.index === 18)?.parsed?.curveInfo?.scale || [];
    expect(wolfBlock18Scale.some((entry) => entry.decoded && entry.layoutKind === 'constant-sentinel16')).toBeTruthy();
    const wolfPrefixScaleBlocks = [1, 3, 6, 7].map((index) => ({
      index,
      scale: wolfDebugDump.blocks.find((block) => block.index === index)?.parsed?.curveInfo?.scale || [],
    }));
    expect(wolfPrefixScaleBlocks.map(({ scale }) => scale[0]?.layoutKind)).toEqual([
      'constant-sentinel16',
      'constant-sentinel16',
      'constant-sentinel16',
      'constant-sentinel16',
    ]);
    expect(wolfPrefixScaleBlocks.every(({ scale }) => scale[0]?.decoded && scale[0]?.structuralProbe?.trailingClass === 'foreign-resource-tail')).toBeTruthy();
    const wolfVectorScaleBlocks = [2, 5].map((index) => wolfDebugDump.blocks.find((block) => block.index === index)?.parsed?.curveInfo?.scale?.[1]);
    expect(wolfVectorScaleBlocks.every((entry) => entry?.decoded && entry.layoutKind === 'scale-vector24')).toBeTruthy();
    const wolfBlock21ForeignScale = wolfDebugDump.blocks.find((block) => block.index === 21)?.parsed?.curveInfo?.scale?.[1];
    expect(wolfBlock21ForeignScale?.decoded && wolfBlock21ForeignScale?.layoutKind === 'foreign-resource-table').toBeTruthy();

    const dragonScaleDump = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/技能/Pss/发招/L_龙王_龙牙烈风拳_红01.pss';
      const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const dragonTaggedScaleEntries = [
      dragonScaleDump.blocks.find((block) => block.index === 21)?.parsed?.curveInfo?.scale?.[1],
      dragonScaleDump.blocks.find((block) => block.index === 22)?.parsed?.curveInfo?.scale?.[1],
    ];
    expect(dragonTaggedScaleEntries.every((entry) => entry?.decoded && entry.layoutKind === 'scale-record24-tagged')).toBeTruthy();
    const dragonBlock22FragmentedScale = dragonScaleDump.blocks.find((block) => block.index === 22)?.parsed?.curveInfo?.scale?.[0];
    expect(dragonBlock22FragmentedScale?.decoded && dragonBlock22FragmentedScale?.layoutKind === 'legacy-fragmented-curve').toBeTruthy();

    const cameraShakeDetail = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/其他/pss/c_曹雪阳枪01.pss';
      const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const liquidEmitters = cameraShakeDetail.analyze.emitters.filter((emitter) => emitter.meshFields?.launcherClassKey === '04010000');
    expect(liquidEmitters).toHaveLength(2);
    expect(liquidEmitters.map((emitter) => emitter.meshFields.launcherClass)).toEqual(['Liquid', 'Liquid']);
    const cameraShakeBlock = cameraShakeDetail.detail.toc.find((block) => block.type === 4 && block.typeLabel === 'camera-shake');
    const cameraShakeParameters = cameraShakeBlock?.emitter?.cameraShake?.parameters;
    expect(cameraShakeParameters).toMatchObject({
      fDuration: 0.5,
      startDelaySeconds: 0.05,
      sampleRateFps: 60,
      nType: 3,
      sampleCount: 30,
      sampleAxisCount: 3,
      sampleDataOffset: 0x44,
    });
    expect(cameraShakeParameters).not.toHaveProperty('field04Float');
    expect(cameraShakeParameters).not.toHaveProperty('field04CandidateNames');
    expect(cameraShakeBlock?.emitter?.cameraShake?.derived).toMatchObject({
      expectedBlockSize: 428,
      expectedSampleBytes: 360,
      durationFromSamples: 0.5,
      durationMatchesSamples: true,
    });
    expect(cameraShakeBlock?.emitter?.cameraShake?.samples).toHaveLength(30);
    expect(cameraShakeBlock?.emitter?.cameraShake?.samples[0]).toMatchObject({ index: 0, timeSeconds: 0, y: 0 });
    expect(cameraShakeBlock?.emitter?.cameraShakeWarning).toBeNull();
    expect(cameraShakeDetail.analyze.emitters.some((emitter) => emitter.type === 'camera-shake' && emitter.cameraShake?.samples?.length === 30)).toBeTruthy();

    const caoSprite16 = cameraShakeDetail.analyze.emitters.find((emitter) => emitter.index === 16 && emitter.type === 'sprite');
    expect(caoSprite16?.sizeCurveStatus).toBe('authored');
    const caoDebugDump = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/其他/pss/c_曹雪阳枪01.pss';
      const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const caoBlock16Scale = caoDebugDump.blocks.find((block) => block.index === 16)?.parsed?.curveInfo?.scale || [];
    expect(caoBlock16Scale.some((entry) => entry.decoded && entry.layoutKind === '4d-implicit-no-header')).toBeTruthy();
    const caoBlock6Scale = caoDebugDump.blocks.find((block) => block.index === 6)?.parsed?.curveInfo?.scale || [];
    expect(caoBlock6Scale[1]?.decoded && caoBlock6Scale[1]?.layoutKind === 'legacy-fragmented-curve').toBeTruthy();
    const caoCameraShakeDumpBlock = caoDebugDump.blocks.find((block) => block.type === 4 && block.parsed?.cameraShake);
    expect(caoCameraShakeDumpBlock?.parsed?.cameraShake?.parameters?.startDelaySeconds).toBe(0.05);
    expect(caoCameraShakeDumpBlock?.uncertain || []).toEqual([]);

    const [heartCloudDetail, beamDetail, beamDebugDump] = await page.evaluate(async () => {
      const detailPaths = [
        'data/source/Home/effect/effect_pss/A_爱心云_001.pss',
        'data/source/Home/effect/effect_pss/B_beam_001.pss',
      ];
      const details = await Promise.all(detailPaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
      const sourcePath = 'data/source/Home/effect/effect_pss/B_beam_001.pss';
      const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
      return [...details, await response.json()];
    });
    for (const pssDetail of [heartCloudDetail, beamDetail]) {
      const tailSemantics = pssDetail.analyze.emitters
        .map((emitter) => emitter.tailParams?.semantic)
        .filter(Boolean);
      expect(tailSemantics).not.toContain('unknown');
    }
    const heartCloudMetadataSprites = heartCloudDetail.analyze.emitters.filter((emitter) => emitter.tailParams?.semantic === 'fixedTrailerMetadata');
    expect(heartCloudMetadataSprites.length).toBeGreaterThan(0);
    expect(heartCloudMetadataSprites.every((emitter) => emitter.runtimeParams?.semantic === 'globalPlayDuration')).toBeTruthy();
    const beamColorSources = beamDetail.analyze.emitters
      .filter((emitter) => emitter.colorCurveStatus === 'no-animation' && emitter.colorCurveSource)
      .map((emitter) => emitter.colorCurveSource);
    expect(beamColorSources).toContain('module:颜色:no-animation');
    expect(beamColorSources.every((source) => !String(source).includes('undecoded'))).toBeTruthy();
    const [qixiuDetail, qixiuDebugDump] = await page.evaluate(async () => {
      const sourcePath = 'data/source/other/HD特效/技能/Pss/发招/q_七秀刀光02.pss';
      const [detailResponse, dumpResponse] = await Promise.all([
        fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`),
        fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`),
      ]);
      return [await detailResponse.json(), await dumpResponse.json()];
    });
    const qixiuType7EmitterIndexes = [2, 3, 4, 8];
    const qixiuType7Emitters = qixiuType7EmitterIndexes.map((index) => qixiuDetail.analyze.emitters.find((emitter) => emitter.index === index && emitter.type === 'sprite'));
    expect(qixiuType7Emitters.map((emitter) => emitter?.launcherTypeId)).toEqual([7, 7, 7, 7]);
    expect(qixiuType7Emitters.every((emitter) => emitter?.launcherClass === 'KG3D_LauncherScale')).toBeTruthy();
    expect(qixiuType7Emitters.every((emitter) => !String(emitter?.launcherHint).includes('unknown'))).toBeTruthy();
    const qixiuType7Blocks = qixiuType7EmitterIndexes.map((index) => qixiuDebugDump.blocks.find((block) => block.index === index)?.parsed);
    for (const block of qixiuType7Blocks) {
      expect(block).toMatchObject({
        launcherTypeId: 7,
        spawnLauncherTypeId: 7,
        launcherClass: 'KG3D_LauncherScale',
        spawnLauncherClass: 'KG3D_LauncherScale',
      });
      expect(block.launcherHint).toContain('scale module token');
      expect(block.spawnLauncherHint).not.toContain('unknown');
    }
    const beamBlock7Scale = beamDebugDump.blocks.find((block) => block.index === 7)?.parsed?.curveInfo?.scale || [];
    expect(beamBlock7Scale[1]?.decoded && beamBlock7Scale[1]?.layoutKind === 'legacy-fragmented-curve').toBeTruthy();
    const expectMalformedValidKeyframeBody = (entry) => {
      expect(entry?.decoded && entry?.layoutKind === 'malformed-valid-keyframe-body').toBeTruthy();
      expect(entry?.effectiveValue).toContain('engine default');
      expect(entry?.structuralProbe).toMatchObject({
        tagAt0: '0x00000000',
        tagInValidRange: true,
        selectedKeyFrameType: 'KG3D_KeyFrame<float>',
        countFieldExceedsPayload: true,
      });
      expect(entry?.structuralProbe?.declaredCountAtPlus4).toBeGreaterThan(entry?.structuralProbe?.maxPossibleFloatBodyRecords);
      expect(entry?.decodeWarning).toBeNull();
    };
    const beamBlock2CurveInfo = beamDebugDump.blocks.find((block) => block.index === 2)?.parsed?.curveInfo || {};
    expectMalformedValidKeyframeBody(beamBlock2CurveInfo.rotation?.[0]);
    expectMalformedValidKeyframeBody(beamBlock2CurveInfo.distortStrength?.[0]);
    const beamBlock7DistortStrength = beamDebugDump.blocks.find((block) => block.index === 7)?.parsed?.curveInfo?.distortStrength || [];
    expectMalformedValidKeyframeBody(beamBlock7DistortStrength[0]);
    const beamBlock7Velocity = beamDebugDump.blocks.find((block) => block.index === 7)?.parsed?.curveInfo?.velocity || [];
    expect(beamBlock7Velocity[0]?.decoded && beamBlock7Velocity[0]?.layoutKind === 'engine-rejected-binary-blob').toBeTruthy();
    expect(beamBlock7Velocity[0]?.effectiveValue).toContain('zero');
    expect(beamBlock7Velocity[0]?.structuralProbe).toMatchObject({
      tagAt0: '0xe5b90000',
      tagInValidRange: false,
    });
    expect(beamBlock7Velocity[0]?.decodeWarning).toBeNull();
    expect(beamBlock7Velocity[1]?.decoded && beamBlock7Velocity[1]?.layoutKind === 'engine-rejected-text-blob').toBeTruthy();
    expect(beamBlock7Velocity[1]?.effectiveValue).toContain('zero');
    expect(beamBlock7Velocity[1]?.structuralProbe?.previewAscii).toContain('normalBias');
    expect(beamBlock7Velocity[1]?.decodeWarning).toBeNull();
    const cloudDebugDump = await page.evaluate(async () => {
      const sourcePath = 'data/source/Home/effect/effect_pss/Cloud_06_Blue01.pss';
      const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
      return response.json();
    });
    const cloudBlock1Offset = cloudDebugDump.blocks.find((block) => block.index === 1)?.parsed?.curveInfo?.offset || [];
    expect(cloudBlock1Offset[0]?.decoded && cloudBlock1Offset[0]?.layoutKind === 'legacy-fwrite-memory-leak').toBeTruthy();
    expect(cloudBlock1Offset[0]?.effectiveValue).toContain('zero');
    expect(cloudBlock1Offset[0]?.layout).toContain('engine defaults channel to zero');
    expect(cloudBlock1Offset[0]?.structuralProbe).toMatchObject({
      tagAt0: '0x305f3400',
      tagInValidRange: false,
    });
    expect(cloudBlock1Offset[0]?.decodeWarning).toBeNull();
    const beamBlock9Rotation = beamDebugDump.blocks.find((block) => block.index === 9)?.parsed?.curveInfo?.rotation || [];
    expect(beamBlock9Rotation[0]?.decoded && beamBlock9Rotation[0]?.layoutKind === 'engine-rejected-binary-blob').toBeTruthy();
    expect(beamBlock9Rotation[0]?.structuralProbe).toMatchObject({
      tagAt0: '0x0000c800',
      tagInValidRange: false,
    });
    expect(beamBlock9Rotation[0]?.decodeWarning).toBeNull();

    const [zeroCountDebugDump, wuxiangDebugDump] = await page.evaluate(async () => {
      const sourcePaths = [
        'data/source/other/HD特效/技能/Pss/发招/A_A394_万灵山双人轻功四段跳_拖尾.pss',
        'data/source/other/HD特效/技能/Pss/发招/w_无相楼_幻境傀儡攻击01.pss',
      ];
      return Promise.all(sourcePaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/debug-dump?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
    });
    const expectValidKeyframeZeroCountBody = (entry) => {
      expect(entry?.decoded && entry?.layoutKind === 'valid-keyframe-zero-count-body').toBeTruthy();
      expect(entry?.decodedKeyCount).toBe(0);
      expect(entry?.keys).toEqual([]);
      expect(entry?.effectiveValue).toContain('engine default');
      expect(entry?.structuralProbe).toMatchObject({
        tagAt0: '0x00000000',
        tagInValidRange: true,
        selectedKeyFrameType: 'KG3D_KeyFrame<float>',
        declaredCountAtPlus4: 0,
        countFieldIsZero: true,
      });
      expect(entry?.structuralProbe?.trailingBytesAfterCount).toBeGreaterThan(0);
      expect(entry?.decodeWarning).toBeNull();
    };
    const zeroCountRotation = zeroCountDebugDump.blocks.find((block) => block.index === 2)?.parsed?.curveInfo?.rotation?.[0];
    expectValidKeyframeZeroCountBody(zeroCountRotation);
    expect(zeroCountRotation?.structuralProbe?.trailingPreviewAscii).toContain('ILVColorBufferSize');
    const wuxiangDistortStrength = wuxiangDebugDump.blocks.find((block) => block.index === 7)?.parsed?.curveInfo?.distortStrength?.[0];
    expectValidKeyframeZeroCountBody(wuxiangDistortStrength);
    expect(wuxiangDistortStrength?.structuralProbe?.trailingPreviewAscii).toContain('_Tex');

    const [waterDropDetail, duoerDetail] = await page.evaluate(async () => {
      const sourcePaths = [
        'data/source/other/HD特效/技能/Pss/发招/A_A021_小水滴_跳跃落地_01.pss',
        'data/source/other/HD特效/技能/Pss/发招/d_朵儿挥手01.pss',
      ];
      return Promise.all(sourcePaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
    });
    expect(waterDropDetail.analyze.emitters.find((emitter) => emitter.index === 1 && emitter.type === 'sprite')?.sizeCurveStatus).toBe('authored');
    expect(duoerDetail.analyze.emitters.find((emitter) => emitter.index === 3 && emitter.type === 'sprite')?.sizeCurveStatus).not.toBe('unparsed');

    const [iceTreeDetail, wuxiangDetail, externalTrailDetail, staticTrailDetail] = await page.evaluate(async () => {
      const sourcePaths = [
        'data/source/Home/effect/effect_pss/B_冰雕树_001.pss',
        'data/source/other/HD特效/技能/Pss/发招/w_无相楼_幻境傀儡攻击01.pss',
        'data/source/other/HD特效/技能/Pss/发招/A_A394_万灵山双人轻功四段跳_拖尾.pss',
        'data/source/other/HD特效/技能/Pss/发招/f2smj10乾坤大法buff01_皮肤04.pss',
      ];
      return Promise.all(sourcePaths.map(async (sourcePath) => {
        const response = await fetch(`/api/pss/detail?sourcePath=${encodeURIComponent(sourcePath)}`);
        return response.json();
      }));
    });
    const embeddedMaterialMesh = iceTreeDetail.analyze.emitters.find((emitter) => emitter.index === 3 && emitter.type === 'mesh');
    expect(embeddedMaterialMesh?.meshFields?.materialIndex).toBe(-1);
    expect(embeddedMaterialMesh?.resolvedMeshes).toHaveLength(1);
    expect(embeddedMaterialMesh?.texturePaths).toHaveLength(0);
    const soundReference = wuxiangDetail.analyze.emitters.find((emitter) => emitter.index === 20 && emitter.type === 'mesh');
    expect(soundReference?.meshFields?.launcherClass).toBe('SoundReference');
    expect(soundReference?.subTypeName).toBe('模板6_声音引用');
    const externalTrail = externalTrailDetail.analyze.emitters.find((emitter) => emitter.index === 5 && emitter.type === 'mesh');
    expect(externalTrail?.trackBindingStatus).toBe('external-runtime-trail');
    expect(externalTrail?.trackBinding).toMatchObject({
      status: 'external-runtime-trail',
      trackEmitterCount: 0,
      meshCount: 0,
      resolvedMeshCount: 0,
      materialIndex: 0,
    });
    const staticTrail = staticTrailDetail.analyze.emitters.find((emitter) => emitter.index === 33 && emitter.type === 'mesh');
    expect(staticTrail?.trackBindingStatus).toBe('static-mesh-material');
    expect(staticTrail?.trackBinding).toMatchObject({
      status: 'static-mesh-material',
      trackEmitterCount: 0,
      meshCount: 1,
      resolvedMeshCount: 1,
      textureCount: 1,
      resolvedTextureCount: 1,
    });

    const syntheticSectionCheck = await page.evaluate(() => {
      const badPss = {
        ok: true,
        magic: 'PSS',
        particleCount: 1,
        detail: {
          sections: [],
          strings: [{ hexOffset: '0x10', text: '疊呅媚吙圚' }],
          toc: [{ index: 1, typeLabel: 'unknown', size: 0, emitter: { type: 'unknown' } }],
        },
        analyze: {
          totalTextures: 1,
          cachedTextures: 0,
          meshes: ['missing.Mesh'],
          resolvedMeshes: 0,
          animations: ['missing.ani'],
          resolvedAnimations: 0,
          tracks: ['missing.trac'],
          resolvedTrackAssets: 0,
          textures: [{ texturePath: 'missing.tga', existsInCache: false }],
          emitters: [{
            index: 1,
            type: 'sprite',
            colorCurveStatus: 'unparsed',
            colorCurveSource: 'module:颜色:(undecoded)',
            tailParams: { semantic: 'unknown' },
            unknownModules: ['未知模块'],
          }],
        },
        debugDump: {
          blocks: [{
            index: 1,
            uncertain: ['gap'],
            parsed: {
              unknownModules: ['未知模块'],
              curveInfo: { scale: [{ decoded: false, layoutKind: 'unparsed', decodeWarning: 'bad' }] },
            },
          }],
        },
      };
      const checks = window.__collectPssDetailSectionChecks(badPss);
      const host = document.createElement('div');
      host.innerHTML = window.__renderPssDetailPayload(badPss);
      document.body.appendChild(host);
      const failCards = [...host.querySelectorAll('.pss-detail-check[data-status="fail"]')].map((el) => el.getAttribute('data-pss-check-section'));
      const failSections = [...host.querySelectorAll('[data-pss-section-check][data-check-status="fail"]')].map((el) => el.getAttribute('data-pss-section-check'));
      host.remove();
      return {
        failedCheckIds: checks.filter((check) => check.status === 'fail').map((check) => check.id),
        failCards,
        failSections,
      };
    });
    expect(syntheticSectionCheck.failedCheckIds).toEqual(expect.arrayContaining(['header', 'emitters', 'assets', 'curves', 'strings', 'debug']));
    expect(syntheticSectionCheck.failCards).toEqual(expect.arrayContaining(['header', 'emitters', 'assets', 'curves', 'strings', 'debug']));
    expect(syntheticSectionCheck.failSections).toEqual(expect.arrayContaining(['header', 'emitters', 'assets', 'curves', 'strings', 'debug']));

    expect(pageErrors).toEqual([]);
  });
});
