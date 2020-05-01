const LRU = require('lru-cache')
const Asciidoctor = require('asciidoctor')
const sanitizeHTML = require('sanitize-html')
const { words, defaultsDeep } = require('lodash')
const path = require('path')

const cache = new LRU({ max: 1000 })
const asciidoctor = Asciidoctor()

const {
  cacheKey,
} = require('./lib/utils')

const {
  HeadingType,
  HeadingLevels
} = require('./lib/types/HeadingType')

const {
  GraphQLInt,
  GraphQLList,
  GraphQLString,
  GraphQLBoolean
} = require('gridsome/graphql')

class AsciidocTransformer {
  static mimeTypes () {
    return [
      'text/asciidoc',
      'text/x-asciidoc',
      'application/asciidoc',
      'application/x-asciidoc',
      'text/adoc',
      'text/x-adoc',
      'application/adoc',
      'application/x-adoc'
    ]
  }

  constructor (options, context) {
    const { localOptions, resolveNodeFilePath } = context
    const defaultOptions = {
      backend: 'html5',
      parse: true,
      safe: 'safe',
    }

    this.options = defaultsDeep(localOptions, options, defaultOptions)
    this.resolveNodeFilePath = resolveNodeFilePath
    this.assets = context.assets || context.queue
  }

  parse (source) {
    // we override the safe option to exclude external includes as we cannot set the base_dir here and resolving those
    // includes would print an error to the console
    const doc = asciidoctor.load(source, {...this.options, safe: 'secure'})
    const docTitle = doc.getDocumentTitle({ partition: true })
    const excerpt = docTitle.getCombined()

    const data = doc.getAttributes()

    return { source, excerpt, ...data }
  }

  extendNodeType () {
    return {
      content: {
        type: GraphQLString,
        resolve: node => this._nodeToHTML(node)
      },
      headings: {
        type: new GraphQLList(HeadingType),
        args: {
          depth: { type: HeadingLevels },
          stripTags: { type: GraphQLBoolean, defaultValue: true }
        },
        resolve: async (node, { depth, stripTags }) => {
          const key = cacheKey(node, 'headings')
          let headings = cache.get(key)

          if (!headings) {
            const ast = await this._nodeToAST(node)
            headings = []
            Object.values(ast.getRefs()).forEach(h => headings.push({
              depth: h.level,
              value: h.title,
              anchor: h.id
            }))
            cache.set(key, headings)
          }

          return headings
        }
      },
      timeToRead: {
        type: GraphQLInt,
        args: {
          speed: {
            type: GraphQLInt,
            description: 'Words per minute',
            defaultValue: 230
          }
        },
        resolve: async (node, { speed }) => {
          const key = cacheKey(node, 'timeToRead')
          let cached = cache.get(key)

          if (!cached) {
            const html = await this._nodeToHTML(node)
            const text = sanitizeHTML(html, {
              allowedAttributes: {},
              allowedTags: []
            })

            const count = words(text).length
            cached = Math.round(count / speed) || 1
            cache.set(key, cached)
          }

          return cached
        }
      }
    }
  }

  _nodeToAST (node) {
    const key = cacheKey(node, 'ast')
    let cached = cache.get(key)

    if (!cached) {
      cached = asciidoctor.load(node.source, {...this.options, base_dir: path.dirname(node.fileInfo.path)})

      cache.set(key, cached)
    }

    return Promise.resolve(cached)
  }

  _nodeToHTML (node) {
    const key = cacheKey(node, 'html')
    let cached = cache.get(key)

    if (!cached) {
      cached = (async () => {
        const ast = await this._nodeToAST(node)

        return ast.convert({...this.options, base_dir: path.dirname(node.fileInfo.path)})
      })()

      cache.set(key, cached)
    }

    return Promise.resolve(cached)
  }
}

module.exports = AsciidocTransformer
