const LRU = require('lru-cache')
const Asciidoctor = require('asciidoctor')
const sanitizeHTML = require('sanitize-html')
const { words, defaultsDeep } = require('lodash')
const path = require('path')
const prismExtension = require('asciidoctor-prism-extension')

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
      prism: true,
      attributes: {
        'source-highlighter': 'prism',
        'prism-languages': 'markup,html,xml,svg,mathml,css,clike,javascript,js,ada,apacheconf,applescript,arduino,asciidoc,adoc,aspnet,bash,shell,batch,bison,brightscript,c,csharp,cs,dotnet,cpp,coffeescript,coffee,cmake,clojure,css-extras,d,dart,diff,django,jinja2,dns-zone,docker,dockerfile,elixir,elm,erb,erlang,xlsx,xls,fsharp,fortran,gcode,git,glsl,go,graphql,groovy,haml,handlebars,haskell,hs,hcl,http,hpkp,hsts,icon,ini,io,java,javadoc,javadoclike,jq,jsdoc,json,jsonp,json5,julia,kotlin,latex,tex,context,latte,less,llvm,lua,makefile,markdown,md,matlab,nasm,neon,nginx,objectivec,ocaml,opencl,parser,pascal,objectpascal,perl,php,phpdoc,php-extras,plsql,powerquery,pq,powershell,processing,properties,protobuf,pug,puppet,pure,python,py,q,qml,r,jsx,tsx,reason,regex,rest,ruby,rb,rust,sas,sass,scss,scala,scheme,shell-session,solidity,solution-file,sln,soy,splunk-spl,sql,stylus,swift,tap,tcl,textile,toml,turtle,trig,twig,typescript,ts,vala,vbnet,velocity,verilog,vhdl,vim,visual-basic,vb,wasm,wiki,xeora,xeoracube,xojo,xquery,yaml,yml,zig'
      }
    }

    this.options = defaultsDeep(localOptions, options, defaultOptions)
    this.resolveNodeFilePath = resolveNodeFilePath
    this.assets = context.assets || context.queue

    if (this.options.prism) {
      asciidoctor.SyntaxHighlighter.register('prism', prismExtension)
    }

    const plugins = options.useBuiltIns === false ? [] : options.plugins || []
    plugins.forEach(plugin => {
      const p = require(plugin);
      p.register(asciidoctor.Extensions)
    });

  }

  parse (source) {
    // we override the safe option to exclude external includes as we cannot set the base_dir here and resolving those
    // includes would print an error to the console
    const doc = asciidoctor.load(source, {...this.options, safe: 'secure'})
    const docTitle = doc.getDocumentTitle({ partition: true })
    const revisionInfo = doc.getRevisionInfo()

    const attributes = doc.getAttributes()

    let dateString = revisionInfo.getDate();
    if (dateString && !dateString.match(/[-+]\d{2,4}/)) {
      dateString = dateString + " GMT"
    }

    const preamble = doc.blocks[0] && doc.blocks[0].blocks[0] && doc.blocks[0].blocks[0].getSource();
    let excerpt = preamble || attributes.description || "";

    const authorlist = []
    Object.entries(attributes).sort((a, b) => b[0].localeCompare(a[0])).forEach(item => {
      if (item[0].startsWith('author_')) {
        const index = item[0].split('_')[1]
        authorlist.push({
          author: attributes[`author_${index}`] || '',
          email: attributes[`email_${index}`] || '',
          firstname: attributes[`firstname_${index}`] || '',
          lastname: attributes[`lastname_${index}`] || '',
          middlename: attributes[`middlename_${index}`] || '',
          authorinitials: attributes[`authorinitials_${index}`] || '',
        })
        delete attributes[`author_${index}`]
        delete attributes[`email_${index}`]
        delete attributes[`firstname_${index}`]
        delete attributes[`lastname_${index}`]
        delete attributes[`middlename_${index}`]
        delete attributes[`authorinitials_${index}`]
      }
    })

    if (authorlist.length === 0) {
      authorlist.push({
        author: attributes.author || '',
        email: attributes.email || '',
        firstname: attributes.firstname || '',
        lastname: attributes.lastname || '',
        middlename: attributes.middlename || '',
        authorinitials: attributes.authorinitials || '',
      })
    }

    delete attributes.author
    delete attributes.email
    delete attributes.firstname
    delete attributes.lastname
    delete attributes.middlename
    delete attributes.authorinitials

    const data = {
      ...attributes,
      title: docTitle.getMain(),
      subtitle: docTitle.getSubtitle(),
      preamble,
      revnumber: Number(revisionInfo.getNumber()),
      revdate: dateString ? new Date(dateString) : null,
      authorlist,
    }

    return { source, excerpt, ...data }
  }

  extendNodeType () {
    return {
      content: {
        type: GraphQLString,
        resolve: node => this._nodeToHTML(node)
      },
      stem: {
        type: GraphQLString,
        resolve: node => node.stem
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
