const hash = require('hash-sum')

exports.cacheKey = function (node, key) {
  return hash({
    content: node.content,
    path: node.internal.origin,
    timestamp: node.internal.timestamp,
    key
  })
}
