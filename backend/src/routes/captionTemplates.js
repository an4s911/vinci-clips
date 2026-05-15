const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const prisma = require('../db/prisma');
const {
    resolveTemplateForLayout,
    buildPhrases,
    buildCaptionASSContent,
    buildASSSubtitleFilter,
    normalizeTemplateUsage,
} = require('../utils/captioning');

const router = express.Router();

function computePreview(data, preview = {}) {
    const savedPreview = preview && typeof preview === 'object' ? preview : {};
    const fontName = data.fontName || 'DejaVu Sans';
    const isMonospace = fontName.toLowerCase().includes('mono') || fontName.toLowerCase() === 'courier';
    const fontFamily = isMonospace ? `"${fontName}", monospace` : `"${fontName}", sans-serif`;
    const shadowDepth = data.shadowDepth ?? 1;
    const backgroundColor = savedPreview.backgroundColor || '#111111';
    return {
        ...savedPreview,
        fontFamily,
        fontWeight: data.bold ? 800 : 400,
        textColor: data.fontColor || '#ffffff',
        backgroundColor,
        captionBackgroundColor: data.borderStyle === 3 && data.backColor ? data.backColor : 'transparent',
        borderColor: data.outlineColor || '#000000',
        borderWidth: data.outlineWidth ?? 0,
        textShadow: data.shadow ? `${shadowDepth}px ${shadowDepth}px ${shadowDepth * 2}px rgba(0,0,0,0.8)` : 'none',
    };
}

const AVAILABLE_FONTS = [
    { name: 'DejaVu Sans', value: 'DejaVu Sans' },
    { name: 'DejaVu Sans Mono', value: 'DejaVu Sans Mono' },
    { name: 'Montserrat', value: 'Montserrat' },
    { name: 'Poppins', value: 'Poppins' },
    { name: 'Bebas Neue', value: 'Bebas Neue' },
    { name: 'Oswald', value: 'Oswald' },
    { name: 'Roboto', value: 'Roboto' },
    { name: 'Anton', value: 'Anton' },
    { name: 'Inter', value: 'Inter' },
];

// These must come before /:id to avoid route collision
router.get('/fonts', (req, res) => {
    res.json({ success: true, fonts: AVAILABLE_FONTS });
});

router.post('/preview', async (req, res) => {
    try {
        const { template, sampleText = 'HELLO WORLD', aspect = 'portrait', bgColor = '#111111' } = req.body;
        if (!template || !template.layouts) {
            return res.status(400).json({ success: false, error: 'Template with layouts required' });
        }

        const dims = aspect === 'landscape'
            ? { width: 1280, height: 720, duration: 3 }
            : aspect === 'square'
                ? { width: 720, height: 720, duration: 3 }
                : { width: 720, height: 1280, duration: 3 };

        const layout = aspect === 'landscape' ? 'landscape' : aspect === 'square' ? 'square' : 'portrait';
        const resolved = resolveTemplateForLayout(template, layout);

        const previewDir = path.join(__dirname, '..', '..', 'uploads', 'caption-previews');
        fs.mkdirSync(previewDir, { recursive: true });

        const fileId = randomUUID();
        const assPath = path.join(previewDir, `${fileId}.ass`);
        const outputPath = path.join(previewDir, `${fileId}.mp4`);

        const words = sampleText.split(/\s+/).filter(Boolean).map((word, i) => ({
            start: `00:${String(i).padStart(2, '0')}:000`,
            end: `00:${String(i + 1).padStart(2, '0')}:000`,
            text: word,
        }));

        const phrases = buildPhrases(words, resolved.maxWordsPerPhrase || 2, resolved.uppercase);
        const assContent = buildCaptionASSContent(phrases, resolved, dims);
        fs.writeFileSync(assPath, assContent);

        const bgHex = bgColor.replace(/^#/, '');
        const bgFilter = `drawbox=x=0:y=0:w=iw:h=ih:color=0x${bgHex}@1.0:t=fill`;
        const subtitleFilter = buildASSSubtitleFilter(assPath);

        await new Promise((resolve2, reject) => {
            ffmpeg()
                .input('/dev/zero')
                .inputOptions([
                    '-f rawvideo',
                    '-pix_fmt rgb24',
                    `-s ${dims.width}x${dims.height}`,
                    '-r 30',
                    '-t 3',
                ])
                .videoFilters([bgFilter, subtitleFilter])
                .outputOptions(['-c:v libx264', '-crf 28', '-preset ultrafast', '-an'])
                .output(outputPath)
                .on('end', resolve2)
                .on('error', reject)
                .run();
        });

        try { fs.unlinkSync(assPath); } catch (_) {}

        res.json({
            success: true,
            previewUrl: `/uploads/caption-previews/${fileId}.mp4`,
        });
    } catch (error) {
        console.error('Caption preview render error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/', async (req, res) => {
    try {
        const templates = await prisma.captionTemplate.findMany({ orderBy: { createdAt: 'asc' } });
        res.json({ success: true, templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const {
            name, description, fontName, fontColor, outlineColor, backColor,
            outlineWidth, shadow, shadowDepth, bold, italic, underline,
            alignment, scaleX, scaleY, spacing, uppercase, borderStyle,
            layouts, preview, usage,
        } = req.body;

        if (!name || !layouts) {
            return res.status(400).json({ success: false, error: 'name and layouts required' });
        }

        const data = {
            fontName: fontName || 'DejaVu Sans',
            fontColor: fontColor || '#ffffff',
            outlineColor: outlineColor || '#000000',
            backColor: backColor || null,
            outlineWidth: outlineWidth ?? 1,
            shadow: shadow ?? false,
            shadowDepth: shadowDepth ?? 1,
            bold: bold ?? true,
            italic: italic ?? false,
            underline: underline ?? false,
            alignment: alignment ?? 2,
            scaleX: scaleX ?? 1,
            scaleY: scaleY ?? 1,
            spacing: spacing ?? 0,
            uppercase: uppercase ?? true,
            borderStyle: borderStyle ?? 1,
        };

        const id = `ct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const template = await prisma.captionTemplate.create({
            data: {
                id,
                name,
                description,
                usage: normalizeTemplateUsage(usage),
                ...data,
                layouts,
                preview: computePreview(data, preview),
            },
        });
        res.json({ success: true, template });
    } catch (error) {
        console.error('Create template error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const template = await prisma.captionTemplate.findUnique({ where: { id: req.params.id } });
        if (!template) return res.status(404).json({ success: false, error: 'Template not found' });
        res.json({ success: true, template });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { id, isSeeded, createdAt, updatedAt, preview, ...data } = req.body;
        delete data.hookOverrides;
        data.usage = normalizeTemplateUsage(data.usage);
        const template = await prisma.captionTemplate.update({
            where: { id: req.params.id },
            data: { ...data, preview: computePreview(data, preview) },
        });
        res.json({ success: true, template });
    } catch (error) {
        console.error('Update template error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await prisma.captionTemplate.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/:id/duplicate', async (req, res) => {
    try {
        const source = await prisma.captionTemplate.findUnique({ where: { id: req.params.id } });
        if (!source) return res.status(404).json({ success: false, error: 'Template not found' });
        const { id, createdAt, updatedAt, ...data } = source;
        const newId = `ct_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const template = await prisma.captionTemplate.create({
            data: { id: newId, isSeeded: false, ...data, name: `${data.name} (copy)` },
        });
        res.json({ success: true, template });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
