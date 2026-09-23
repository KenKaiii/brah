export function shouldTryDefaultMicrophone(error) {
  return ["NotFoundError", "OverconstrainedError", "NotReadableError"].includes(error?.name);
}

// Fail promptly if either operation fails, but release the mic even when it
// arrives after a failed secret request (e.g. an unanswered permission prompt).
export async function acquireCallResources(getSecret, getMicrophone) {
  const microphone = Promise.resolve().then(getMicrophone);
  const secret = Promise.resolve().then(getSecret);
  try {
    const [value, stream] = await Promise.all([secret, microphone]);
    return { secret: value, stream };
  } catch (error) {
    void microphone.then(
      (stream) => {
        for (const track of stream.getTracks()) track.stop();
      },
      () => {},
    );
    throw error;
  }
}
