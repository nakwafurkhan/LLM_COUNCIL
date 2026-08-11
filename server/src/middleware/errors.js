export function notFound(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  res.status(404).json({ error: { message: `No API route for ${req.method} ${req.path}` } });
}

/* Four arguments — Express identifies error handlers by arity, so none of these
   can be dropped even though `next` looks unused. */
export function errorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('  [error]', err);
  res.status(status).json({
    error: {
      message: err.message || 'Internal error',
      ...(err.requestId ? { requestId: err.requestId } : {})
    }
  });
}
