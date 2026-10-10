export function isCurrentEvidenceRequest(activeRequest, request) {
  return Boolean(
    activeRequest
    && request
    && activeRequest.token === request.token
    && activeRequest.predictionId === request.predictionId,
  );
}
