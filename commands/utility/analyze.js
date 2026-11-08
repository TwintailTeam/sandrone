const { SlashCommandBuilder, MessageFlags, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { TYPES, AnalyzeError } = require('../../utils/analyzers');
const { formatBytes } = require('../../utils/analyzers/reader');
const { runInWorker } = require('../../utils/worker');

const ANALYZER = require.resolve('../../utils/analyzers');
const WORKER_OPTIONS = { timeoutMs: 30_000, heapLimitMb: 768, concurrency: 2 };
const FRIENDLY_ERRORS = new Set(['AnalyzeError', 'WorkerError']);
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;
const UPLOAD_HEADROOM = 64 * 1024;
const CRASH_COLOUR = 0xed4245;
const LOG_COLOUR = 0x5865f2;

const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const code = (text, length = 1000) => `\`${clip(String(text).replace(/`/g, "'"), length)}\``;

function crashEmbed(result, attachment) {
    const { summary } = result;
    const fields = [
        summary.location && { name: 'Location', value: code(summary.location) },
        summary.faultHint && { name: 'Faulting module', value: clip(summary.faultHint, 1024) },
        summary.engineVersion && { name: 'Engine', value: clip(`${summary.engineVersion}${summary.backend ? `\n${summary.backend}` : ''}`, 1024) },
        summary.process && { name: 'Process', value: code(summary.process), inline: true },
        summary.os && { name: 'OS', value: clip(summary.os, 1024), inline: true },
        summary.gpu && { name: 'GPU', value: clip(summary.gpu, 1024), inline: true },
        summary.notes.length && { name: 'Notes', value: clip(summary.notes.join('\n'), 1024) },
        result.totalFiles > 1 && { name: 'Files', value: `${result.analyzedFiles} of ${result.totalFiles} analyzed (${result.kinds.join(', ')})` },
        result.warnings.length && { name: 'Warnings', value: clip(result.warnings.map((warning) => `⚠️ ${warning}`).join('\n'), 1024) },
    ].filter(Boolean);
    return new EmbedBuilder().setColor(CRASH_COLOUR).setTitle(clip(`Crash Analysis | ${result.engine}`, 256)).setDescription(clip(`**${summary.exception ?? 'Unknown crash'}**${summary.detail ? `\n${summary.detail}` : ''}`, 4096))
        .addFields(fields).setFooter({ text: clip(`${attachment.name} • ${result.kinds.join(', ')} • full report attached${result.compressed ? ' (gzip)' : ''}`, 2048) });
}

function logEmbed(result, attachment) {
    const { summary } = result;
    const fields = [
        summary.opened && { name: 'Session opened', value: summary.opened, inline: true },
        summary.closed && { name: 'Session closed', value: summary.closed, inline: true },
        { name: 'Lines', value: summary.lineCount.toLocaleString('en-US'), inline: true },
        { name: 'Errors', value: summary.errors.toLocaleString('en-US'), inline: true },
        { name: 'Warnings', value: summary.warnings.toLocaleString('en-US'), inline: true },
        result.warnings.length && { name: 'Notes', value: clip(result.warnings.map((warning) => `⚠️ ${warning}`).join('\n'), 1024) },
    ].filter(Boolean);
    return new EmbedBuilder().setColor(LOG_COLOUR).setTitle('Log Decrypted | Wuthering Waves').setDescription(`Decrypted **${clip(attachment.name, 200)}** (${summary.size}).`)
        .addFields(fields).setFooter({ text: `decrypted log attached${result.compressed ? ' (gzip, over the upload limit uncompressed)' : ''}` });
}

module.exports = {
    cooldown: 15,
    data: new SlashCommandBuilder().setName('analyze').setDescription('Analyzes a Unity or Unreal crash file, or decrypts a Wuthering Waves log.')
        .addStringOption((option) => option.setName('type').setDescription('What kind of file you are uploading.').setRequired(true).addChoices(...Object.entries(TYPES).map(([value, name]) => ({ name: clip(name, 100), value }))))
        .addStringOption((option) => option.setName('engine').setDescription('The engine the game is made with.').setRequired(true).addChoices({ name: 'Unity (2017 and newer)', value: 'unity' }, { name: 'Unreal Engine (4 or 5)', value: 'unreal' }))
        .addAttachmentOption((option) => option.setName('file').setDescription('The crash dump, crash folder zip, crash report or log.').setRequired(true))
        .addBooleanOption((option) => option.setName('public').setDescription('Post the result in the channel instead of only showing it to you.')),
    async execute(interaction) {
        const isPublic = interaction.options.getBoolean('public') ?? false;
        await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });

        const attachment = interaction.options.getAttachment('file', true);
        const type = interaction.options.getString('type', true);
        const engine = interaction.options.getString('engine', true);
        if (attachment.size > MAX_DOWNLOAD_BYTES) {
            return interaction.editReply({ content: `${attachment.name} is ${formatBytes(attachment.size)}; the limit is ${formatBytes(MAX_DOWNLOAD_BYTES)}. Zip the crash folder or upload only the .dmp / .runtime-xml.` });
        }

        try {
            const response = await fetch(attachment.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!response.ok) { throw new AnalyzeError(`Could not download the upload from Discord (HTTP ${response.status}).`); }
            const data = await response.arrayBuffer();
            if (data.byteLength > MAX_DOWNLOAD_BYTES) { throw new AnalyzeError(`The file is larger than ${formatBytes(MAX_DOWNLOAD_BYTES)}.`); }

            const outputLimit = Math.max((interaction.attachmentSizeLimit ?? DEFAULT_UPLOAD_LIMIT) - UPLOAD_HEADROOM, 1024 * 1024);
            const result = await runInWorker(ANALYZER, 'analyze', [data, attachment.name, { type, engine, outputLimit }], { ...WORKER_OPTIONS, transferList: [data] });
            const output = Buffer.from(result.output.buffer, result.output.byteOffset, result.output.byteLength);
            const embed = result.detectedType === 'wuwa_log' ? logEmbed(result, attachment) : crashEmbed(result, attachment);
            await interaction.editReply({ embeds: [embed], files: [new AttachmentBuilder(output, { name: result.outputName })] });
        } catch (error) {
            const friendly = FRIENDLY_ERRORS.has(error.name);
            if (!friendly) { console.error(`[analyze] ${attachment.name}:`, error); }
            const message = friendly ? error.message : error.name === 'TimeoutError' ? 'Downloading the file from Discord timed out.' : 'Something went wrong while analyzing this file.';
            await interaction.editReply({ content: clip(message, 2000), embeds: [], files: [] }).catch((replyError) => console.error('[analyze] could not send the error reply:', replyError));
        }
    },
};
