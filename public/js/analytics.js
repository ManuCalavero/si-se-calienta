// Vercel Web Analytics
// Dynamically import and inject analytics
(async () => {
  try {
    const { inject } = await import('/analytics/index.mjs');
    inject();
  } catch (error) {
    // Silently fail in development or if analytics is not available
    console.debug('Analytics not loaded:', error.message);
  }
})();
