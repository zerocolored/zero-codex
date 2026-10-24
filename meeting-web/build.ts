const result = await Bun.build({entrypoints:[new URL('./avatar.ts',import.meta.url).pathname],target:'browser',format:'esm',minify:true})
if (!result.success) throw new Error('Avatar SDK build failed')
await Bun.write(new URL('./public/simli.js',import.meta.url),result.outputs[0]!)
