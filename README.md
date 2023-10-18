# vite-plugin-lib-emit-assets

注意：本项目基于 [vite-plugin-lib-assets](https://github.com/laynezh/vite-plugin-lib-assets) 改造而来。

Vite 插件：用于提取 [`library mode`](https://vitejs.dev/guide/build.html#library-mode) 构建时引用到的资源文件，而不是以 base64 形式內联它们

## 安装

```bash
npm i vite-plugin-lib-emit-assets -D
```

或

```bash
yarn add vite-plugin-lib-emit-assets -D
```

或

```bash
pnpm add vite-plugin-lib-emit-assets -D
```

## 使用

```typescript
// vite.config.ts
import libAssets from 'vite-plugin-lib-emit-assets'

export default defineConfig({
  plugins: [
    libAssets({ /* options */ }),
  ],
})
```

## 配置项

```typescript
export interface Options {
  include?: string | RegExp | (string | RegExp)[]
  exclude?: string | RegExp | (string | RegExp)[]
  name?: string | ((resourcePath: string, resourceQuery: string) => string)
  limit?: number
  publicUrl?: string
}
```

### `include`

一个或一组 [picomatch](https://github.com/micromatch/picomatch#globbing-features) 表达式，指明哪些文件需要被插件处理。

- Type: `string | RegExp | (string | RegExp)[]`
- Default: 与 Vite [`assetsInclude`](https://vitejs.dev/config/shared-options.html#assetsinclude) 选项的默认值一样，可以在[这里](https://github.com/vitejs/vite/blob/main/packages/vite/src/node/constants.ts#L91-L135)找到完整的列表。
- Example:
  ```typescript
  libAssetsPlugin({
    include: /\.a?png(\?.*)?$/
  })
  ```

### `exclude`

和 `include` 一样，但是用来指明哪些文件需要被插件忽略。

- Type: `string | RegExp | (string | RegExp)[]`
- Default: `undefined`.
- Example:
  ```typescript
  libAssetsPlugin({
    exclude: /\.svg(\?.*)?$/
  })
  ```

### name

资源文件的输出名称，与 `file-loader` 的 [`name`](https://github.com/webpack-contrib/file-loader#name) 配置行为一致

- Type: `string | ((resourcePath: string, resourceQuery: string) => string)`
- Default: `'[contenthash].[ext]'`
- Example:
  - `string`
    ```typescript
    assetsLibPlugin({
      name: '[name].[contenthash:8].[ext]?[query]'
    })
    ```
  - `function`
    ```typescript
    assetsLibPlugin({
      name: (resourcePath, resourceQuery) => {
        // `resourcePath` - `/absolute/path/to/file.js`
        // `resourceQuery` - `foo=bar`
    
        if (process.env.NODE_ENV === 'development') {
          return '[name].[ext]';
        }
    
        return  '[name].[contenthash:8].[ext]?[query]'
      },
    })
    ```
> 完整的占位符列表见 [`loader-utils#interpolatename`](https://github.com/webpack/loader-utils#interpolatename)

### `limit`

低于 `limit` 设置体积的文件会以 base64 的格式內联到产物中

- Type: `number`，单位 `Byte`
- Default: `undefined`，表示所有文件都不会被内联
- Example:
  ```typescript
  assetsLibPlugin({
    limit: 1024 * 8 // 8KB
  })
  ```

### `publicUrl`

资源部署到 CDN 时的路径前缀，***这个选项在构建 `cjs` 和 `esm` 格式时也会生效***

- Type: `string`
- Default: `''`
- Example:
  ```typescript
  assetsLibPlugin({
    publicUrl: 'https://cdn.jsdelivr.net/npm/vite-plugin-lib-emit-assets'
  })
  ```