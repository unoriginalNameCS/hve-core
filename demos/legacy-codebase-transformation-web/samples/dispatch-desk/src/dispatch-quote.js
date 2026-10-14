'use strict';

function summarizeDispatch(request) {
  let ready = false;
  let reference = null;
  let reason = 'request is missing';
  let packageCount = 0;

  if (request) {
    if (typeof request.reference === 'string' && request.reference.trim()) {
      reference = request.reference;
      if (request.status === 'ready') {
        if (request.destination && ['local', 'regional', 'remote'].includes(request.destination.zone)) {
          if (Array.isArray(request.packages)) {
            if (request.packages.length > 0) {
              if (request.packages.every((parcel) => parcel && Number.isFinite(parcel.weight) && parcel.weight > 0)) {
                ready = true;
                reason = null;
                packageCount = request.packages.length;
              } else { reason = 'every package must have a positive finite weight'; }
            } else { reason = 'at least one package is required'; }
          } else { reason = 'packages must be provided as a list'; }
        } else { reason = 'destination zone is not supported'; }
      } else { reason = 'request is not ready to dispatch'; }
    } else { reason = 'reference is missing'; }
  }

  return { ready, reference, reason, packageCount };
}

module.exports = { summarizeDispatch };
