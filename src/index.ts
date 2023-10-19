import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Buffer } from 'node:buffer';
import type { LibraryFormats } from 'vite';
import { type Alias, createFilter, type Plugin, preprocessCSS, type ResolvedConfig } from 'vite';
import { type PluginContext } from 'vite/node_modules/rollup/dist/rollup';
import { interpolateName } from 'loader-utils';
import type * as _compiler from 'vue/compiler-sfc';
import type { SFCDescriptor } from 'vue/compiler-sfc';
import * as mrmime from 'mrmime';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import slash from 'slash';

let viteConfig: ResolvedConfig;
const assetsPathMap = new Map<string, string>();
const base64AssetsPathMap = new Map<string, string>();
let name: string;
let limit: number;
let publicUrl: string;
let publicDir: string;
let filter: (id: string | unknown) => boolean;
let cssLangFilter: (id: string | unknown) => boolean;
let assetsImporterFilter: (id: string | unknown) => boolean;

export default function (options: Options = {}): Plugin {
  const { include = DEFAULT_ASSETS_RE, exclude } = options;
  name = options.name || '[contenthash].[ext]';
  limit = options.limit ?? 0;
  publicUrl = options.publicUrl ?? '';
  publicDir = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;

  filter = createFilter(include, exclude);
  cssLangFilter = createFilter(CSS_LANG_RE);
  assetsImporterFilter = createFilter(ASSETS_IMPORTER_RE);

  return {
    name: 'vite-plugin-lib-assets',
    apply: 'build',
    enforce: 'pre',
    configResolved,
    resolveId(source, importer = '') {
      return externalResolveId(this, source, importer);
    },
    load,
    writeBundle,
  };
}

// region types --------------------------------------------------------------------------------------------------------

type LoaderContext = Parameters<typeof interpolateName>[0];

export interface Options {
  include?: string | RegExp | (string | RegExp)[];
  exclude?: string | RegExp | (string | RegExp)[];
  name?: string;
  limit?: number;
  publicUrl?: string;
}

export interface DescriptorOptions {
  root: string;
  compiler: {
    impl: typeof _compiler;
    version: string;
  };
}

// endregion

// region configResolved -----------------------------------------------------------------------------------------------

function configResolved(config: ResolvedConfig) {
  viteConfig = config;
  if (viteConfig.build.lib !== false) {
    const { formats = ['es', 'umd'] } = viteConfig.build.lib;
    const valid = checkFormats(formats);
    if (!valid && publicUrl) {
      console.warn('[vite-plugin-lib-assets] The publicUrl configuration will be applied to all output formats.');
    }
  }
}

// endregion

// region load ---------------------------------------------------------------------------------------------------------

function load(id: string): string {
  if (!viteConfig.build.lib) return null;

  const assetPath = assetsPathMap.get(id);
  if (assetPath) return `export default '${publicDir}${assetPath}'`;
}

// endregion

// region resolveId ----------------------------------------------------------------------------------------------------

/**
 * 外部的 resolveId 方法，用于处理资源的 ID。
 * @param {PluginContext} context - 插件上下文。
 * @param {string} source - 资源源路径。
 * @param {string} [importer=''] - 引入的路径。
 * @returns {Promise<any>} - 解析后的资源路径。
 */
async function externalResolveId(context: PluginContext, source: string, importer: string = ''): Promise<any> {
  if (viteConfig.build.lib === false) return null;

  const id = resolveFullId(importer, source);

  if (cssLangFilter(id)) await handleCssAssets(context, id);

  if (!filter(id)) return null;

  const content = getAssetContent(id);
  if (!content || (limit && content.byteLength <= limit)) return null;

  const assetPath = emitAsset(context, id, name, content);
  return publicUrl ? assetsPathMap.set(id, assetPath) && id : { id: `./${assetPath}`, external: 'relative' };
}

/**
 * 通过给定的路径解析完整的 ID。
 * @param {string} importer - 导入路径。
 * @param {string} source - 资源源路径。
 * @returns {string} - 完整的资源路径。
 */
function resolveFullId(importer: string, source: string): string {
  const importerDir = importer.endsWith(path.sep) ? importer : path.dirname(importer);
  return path.resolve(importerDir, source);
}

/**
 * 发射文件到输出目录。
 * @param {PluginContext} context - 插件上下文。
 * @param {string} id - 文件的 ID。
 * @param {string} name - 文件名称。
 * @param {Buffer} content - 文件内容。
 * @returns {string} - 发射的文件路径。
 */
function emitAsset(context: PluginContext, id: string, name: string, content: Buffer): string {
  const [pureId, resourceQuery] = id.split('?');
  const url = interpolateName({ resourcePath: pureId, resourceQuery } as LoaderContext, name, { content });
  const assetPath = path.join(viteConfig.build.assetsDir, url);
  const filename = assetPath.replace(`?${resourceQuery}`, '');
  const fullname = path.join(viteConfig.build.outDir, assetPath);

  context.emitFile({
    fileName: filename,
    name: fullname,
    source: content,
    type: 'asset',
  });

  return assetPath;
}

/**
 * 处理 CSS 文件中的资源。
 * @param {PluginContext} context - 插件上下文。
 * @param {string} id - 文件的 ID。
 */
async function handleCssAssets(context: PluginContext, id: string): Promise<void> {
  const assetsFromCss = await extractFromFile(context, id);

  assetsFromCss.filter(filter).forEach((assetId) => {
    const content = getAssetContent(assetId);
    if (!content || (limit && content.byteLength <= limit)) return;

    const assetPath = emitAsset(context, assetId, name, content);
    if (publicUrl) base64AssetsPathMap.set(getFileBase64(assetId, content), `${publicDir}${assetPath}`);
  });
}

/**
 * 从文件中提取资源。
 * @param {PluginContext} context - 插件上下文。
 * @param {string} id - 文件的 ID。
 * @returns {Promise<string[]>} - 提取的资源列表。
 */
async function extractFromFile(context: PluginContext, id: string): Promise<string[]> {
  const descriptorOptions: DescriptorOptions = {
    compiler: null as any, // 在 buildStart 中设置
    root: process.cwd(),
  };

  const content = getAssetContent(id);
  if (!content) return [];

  // 检查是否为 Vue 文件，并处理其中的样式资源
  const [pureId] = id.split('?', 2);
  if (path.extname(pureId) === '.vue') {
    if (!descriptorOptions.compiler) descriptorOptions.compiler = resolveCompiler(descriptorOptions.root);

    const descriptor = getDescriptor(pureId, id, descriptorOptions);
    if (descriptor === undefined) return [];

    const extractedAssetList = await Promise.all(
      descriptor.styles.map((style) => extractFromSource(context, id, style.content))
    );

    return extractedAssetList.flatMap((extractedAssets) => extractedAssets);
  }

  return extractFromSource(context, id, content.toString());
}

/**
 * 从资源内容中提取资源链接。
 * @param {PluginContext} context - 插件上下文。
 * @param {string} id - 资源的 ID。
 * @param {string} content - 资源的内容。
 * @returns {Promise<string[]>} - 提取的资源链接列表。
 */
async function extractFromSource(context: PluginContext, id: string, content: string): Promise<string[]> {
  let source = content;
  try {
    const result = await preprocessCSS(content, id, viteConfig);
    source = result.code;
  } catch (err) {
    console.warn(`[vite-plugin-lib-assets]: 处理预处理 CSS 时失败 ${err}`);
  }

  const cssUrlAssets = getCaptured(source, cssUrlRE);
  const cssImageSetAssets = getCaptured(source, cssImageSetRE);
  const assets = [...cssUrlAssets, ...cssImageSetAssets];
  const pureAssets = assets.map((asset) =>
    asset.startsWith("'") || asset.startsWith('"') ? asset.slice(1, -1) : asset
  );

  return resolve(context, viteConfig.resolve.alias, Array.from(new Set(pureAssets)), id);
}

// endregion

// region writeBundle --------------------------------------------------------------------------------------------------

/**
 * 写入 bundle
 */
async function writeBundle(_: any, outputBundle: { [x: string]: any }) {
  const initialSourceMap = createBundleSourceMap(outputBundle);
  const sourceMapAfterStyleProcessing = replaceBase64WithAssetPath(initialSourceMap);
  const finalSourceMap = adjustResourceAddress(sourceMapAfterStyleProcessing);

  const outputDir = path.resolve(viteConfig.build.outDir);
  for (const name of Object.keys(initialSourceMap).filter((name) => initialSourceMap[name] !== finalSourceMap[name])) {
    const outputPath = path.join(outputDir, name);
    await promisify(fs.writeFile)(outputPath, finalSourceMap[name]);
  }
}

/**
 * 根据 outputBundle 创建 bundle 的 source map
 */
function createBundleSourceMap(outputBundle: { [x: string]: any }): Record<string, string> {
  return Object.keys(outputBundle).reduce((map, name) => {
    const bundle = outputBundle[name];
    map[name] = 'source' in bundle ? String(bundle.source) : bundle.code;
    return map;
  }, {} as Record<string, string>);
}

/**
 * 替换样式中的 base64 为资产路径
 */
function replaceBase64WithAssetPath(bundleSourceMap: Record<string, string>): Record<string, string> {
  const updatedSourceMap = { ...bundleSourceMap };
  const assetsInStyle = base64AssetsPathMap.entries();

  for (const name of Object.keys(updatedSourceMap).filter((name) => path.extname(name) === '.css')) {
    let updated = updatedSourceMap[name];
    for (const [base64, asset] of assetsInStyle) {
      updated = updated.replaceAll(base64, publicUrl ? asset : `./${asset}`);
    }

    updatedSourceMap[name] = updated;
  }

  return updatedSourceMap;
}

/**
 * 根据导入者的输出路径修改提取的资源地址
 */
function adjustResourceAddress(bundleSourceMap: Record<string, string>): Record<string, string> {
  const updatedSourceMap = { ...bundleSourceMap };
  const assetsExtracted = Object.keys(updatedSourceMap).filter((id) => filter(id));

  for (const name of Object.keys(updatedSourceMap).filter((name) => assetsImporterFilter(name))) {
    let updated = updatedSourceMap[name];
    const fileDir = path.dirname(name);
    for (const asset of assetsExtracted) {
      const relativeAsset = path.relative(fileDir, asset);
      const originalAsset = `./${asset}`;
      if (asset !== relativeAsset && updated.includes(originalAsset)) {
        updated = updated.replaceAll(originalAsset, relativeAsset);
      }
    }

    updatedSourceMap[name] = updated;
  }

  return updatedSourceMap;
}

// endregion

// region utils --------------------------------------------------------------------------------------------------------

type IntermediateFormats = Array<'es' | 'cjs'>;
type FinalFormats = Array<'umd' | 'iife'>;

const intermediateFormats: IntermediateFormats = ['es', 'cjs'];
const finalFormats: FinalFormats = ['umd', 'iife'];

export function checkFormats(formats: LibraryFormats[]) {
  const isIntermediateFormat = formats.some((format) =>
    intermediateFormats.includes(format as IntermediateFormats[number])
  );
  const isFinalFormat = formats.some((format) => finalFormats.includes(format as FinalFormats[number]));

  return Number(isIntermediateFormat) + Number(isFinalFormat) === 1;
}

const assetsContentMap = new Map<string, Buffer>();

export function getAssetContent(id: string) {
  let content: Buffer | undefined | null = assetsContentMap.get(id);
  const pureId = id.split('?')[0];
  if (!content) {
    if (!fs.existsSync(pureId)) {
      console.warn(`[vite-plugin-lib-assets]: file not found ${id}`);
      content = null;
    } else {
      content = fs.readFileSync(pureId);
      assetsContentMap.set(id, content);
    }
  }

  return content;
}

const postfixRE = /[?#].*$/s;

function cleanUrl(url: string): string {
  return url.replace(postfixRE, '');
}

export function getFileBase64(id: string, content: Buffer): string {
  const file = cleanUrl(id);
  const mimeType = mrmime.lookup(file) ?? 'application/octet-stream';
  // base64 inlined as a string
  return `data:${mimeType};base64,${content!.toString('base64')}`;
}

export function getCaptured(input: string, re: RegExp): string[] {
  const captures = [];
  let match: RegExpExecArray | null;
  let remaining = input;
  // eslint-disable-next-line no-cond-assign
  while ((match = re.exec(remaining))) {
    match[1] !== undefined && captures.push(match[1]);
    remaining = remaining.slice(match.index + match[0].length);
  }

  return captures;
}

// endregion

// region alias --------------------------------------------------------------------------------------------------------

function matches(pattern: string | RegExp, importee: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(importee);

  if (importee.length < pattern.length) return false;

  if (importee === pattern) return true;

  return importee.startsWith(`${pattern}/`);
}

export async function resolve(
  context: PluginContext,
  alias: Alias[],
  importers: string[],
  importer: string
): Promise<string[]> {
  const resolves = importers.map(async (importee) => {
    const matched = alias.find((alias) => matches(alias.find, importee));

    const updated = matched ? importee.replace(matched.find, matched.replacement) : importee;

    return context
      .resolve(updated, importer, { skipSelf: true })
      .then((resolved) => (resolved !== null ? resolved.id : updated));
  });

  return Promise.all(resolves);
}

// endregion

// region compiler -----------------------------------------------------------------------------------------------------

// 扩展描述符，使得我们可以存储一个自定义 id
declare module 'vue/compiler-sfc' {
  interface SFCDescriptor {
    id: string;
  }
}

export function resolveCompiler(root: string): DescriptorOptions['compiler'] {
  // resolve from project root first, then fallback to peer dep (if any)
  const vueMeta = tryRequire('vue/package.json', root);
  const version = vueMeta ? vueMeta.version.split('.')[0] : '';
  const compiler = tryRequire('vue/compiler-sfc', root) || tryRequire('vue/compiler-sfc');

  if (!compiler) {
    throw new Error(
      'Failed to resolve vue/compiler-sfc.\n' +
        'vite-plugin-vue-setup-name requires vue (>=2.7.0) ' +
        'to be present in the dependency tree.'
    );
  }

  return { impl: compiler, version };
}

const _require = createRequire(import.meta.url);

function tryRequire(id: string, from?: string) {
  try {
    return from ? _require(_require.resolve(id, { paths: [from] })) : _require(id);
  } catch (e) {}
}

// endregion

// region 常量

// ** READ THIS ** before editing `KNOWN_ASSET_TYPES`.
//   If you add an asset to `KNOWN_ASSET_TYPES`, make sure to also add it
//   to the TypeScript declaration file `packages/vite/client.d.ts` and
//   add a mime type to the `registerCustomMime` in
//   `packages/vite/src/node/plugin/assets.ts` if mime type cannot be
//   looked up by mrmime.
const KNOWN_ASSET_TYPES = [
  // images
  'apng',
  'png',
  'jpe?g',
  'jfif',
  'pjpeg',
  'pjp',
  'gif',
  'svg',
  'ico',
  'webp',
  'avif',

  // media
  'mp4',
  'webm',
  'ogg',
  'mp3',
  'wav',
  'flac',
  'aac',
  'opus',

  // fonts
  'woff2?',
  'eot',
  'ttf',
  'otf',

  // other
  'webmanifest',
  'pdf',
  'txt',
];

const DEFAULT_ASSETS_RE = new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})(\\?.*)?$`);

const CSS_LANG_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

// https://drafts.csswg.org/css-syntax-3/#identifier-code-point
const cssUrlRE = /(?<=^|[^\w\-\u0080-\uFFFF])url\((\s*('[^']+'|"[^"]+")\s*|[^'")]+)\)/;

// Assuming a function name won't be longer than 256 chars
const cssImageSetRE = /(?<=image-set\()((?:[\w\-]{1,256}\([^)]*\)|[^)])*)(?=\))/;

const ASSETS_IMPORTER_RE = /\.(css|js|cjs|mjs)(?:$|\?)/;

// endregion

// region descriptorCache

const cache = new Map<
  string,
  {
    mtime: number;
    descriptor: SFCDescriptor;
  }
>();

// compiler-sfc should be exported so it can be re-used
interface SFCParseResult {
  descriptor: SFCDescriptor;
  errors: Error[];
}

/**
 * 从缓存或者文件系统中获取 SFC 描述符。
 * @param {string} filename - 文件路径。
 * @param {string} id - 文件的唯一标识。
 * @param {DescriptorOptions} options - 解析选项。
 * @param {boolean} createIfNotFound - 如果描述符在缓存中未找到是否创建新的。
 * @returns {SFCDescriptor | undefined} - 返回 SFC 描述符或者 undefined。
 */
function getDescriptor(
  filename: string,
  id: string,
  options: DescriptorOptions,
  createIfNotFound: boolean = true
): SFCDescriptor | undefined {
  const { mtimeMs } = fs.statSync(filename);
  const cachedDescriptor = cache.get(filename);
  if (cachedDescriptor && cachedDescriptor.mtime === mtimeMs) return cachedDescriptor.descriptor;

  if (createIfNotFound) {
    const { descriptor, errors } = createDescriptor(filename, id, fs.readFileSync(filename, 'utf-8'), options);
    if (errors.length) throw errors[0];

    return descriptor;
  }
}

/**
 * 创建一个新的 SFC 描述符并存储到缓存。
 * @param {string} filename - 文件路径。
 * @param {string} id - 文件的唯一标识。
 * @param {string} source - 文件内容。
 * @param {DescriptorOptions} options - 解析选项。
 * @returns {SFCParseResult} - 包括描述符和错误的解析结果。
 */
function createDescriptor(
  filename: string,
  id: string,
  source: string,
  { root, compiler }: DescriptorOptions
): SFCParseResult {
  const { descriptor, errors } = parseSFC(id, source, compiler);
  // ensure the path is normalized in a way that is consistent inside
  // project (relative to root) and on different systems.
  const normalizedPath = slash(path.normalize(path.relative(root, filename)));
  descriptor.id = getHash(normalizedPath);
  const { mtimeMs } = fs.statSync(filename);

  cache.set(filename, { mtime: mtimeMs, descriptor });
  return { descriptor, errors };
}

/**
 * 使用 Vue 编译器解析 SFC 文件。
 * @param {string} id - 文件的唯一标识。
 * @param {string} source - 文件内容。
 * @param {string} version - Vue 版本
 * @param compiler - Vue 编译器
 * @returns {SFCParseResult} - 包括描述符和错误的解析结果。
 */
function parseSFC(
    id: string,
    source: string,
    { version, impl: compiler }: DescriptorOptions['compiler']
): SFCParseResult {
  let result: SFCParseResult;
  if (version === '2') {
    let descriptor: SFCDescriptor;
    let errors: Error[] = [];
    try {
      // @ts-expect-error vue3 has different signature
      descriptor = compiler.parse({ source, id, sourceMap: false });
    } catch (e) {
      errors = [e as Error];
      // @ts-expect-error vue3 has different signature
      descriptor = compiler.parse({ source: '', filename: id });
    }
    result = { descriptor, errors };
  } else if (version === '3') {
    // ts-expect-error vue2 has different signature
    result = compiler.parse(source, { filename: id, sourceMap: false });
  } else {
    throw new Error('Unknown vue version');
  }

  return result;
}

/**
 * 为给定文本计算哈希。
 * @param {string} text - 输入文本。
 * @returns {string} - 哈希字符串。
 */
function getHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 8);
}

// endregion
