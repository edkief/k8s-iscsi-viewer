import * as k8s from "@kubernetes/client-node";

// Singleton clients. Auto-detect in-cluster (ServiceAccount) vs local kubeconfig.
// In-cluster is signalled by the KUBERNETES_SERVICE_HOST env var that the kubelet
// injects into every pod; otherwise we fall back to the developer's ~/.kube/config.

let core: k8s.CoreV1Api | null = null;
let storage: k8s.StorageV1Api | null = null;

function loadConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  return kc;
}

function clients() {
  if (!core || !storage) {
    const kc = loadConfig();
    core = kc.makeApiClient(k8s.CoreV1Api);
    storage = kc.makeApiClient(k8s.StorageV1Api);
  }
  return { core, storage };
}

// Each list is paginated transparently by the API server for our scale; for very
// large clusters a _continue loop could be added, but PV/PVC counts stay modest.
export async function listAll() {
  const { core, storage } = clients();
  const [pvcs, pvs, pods, volumeAttachments, storageClasses] = await Promise.all([
    core.listPersistentVolumeClaimForAllNamespaces(),
    core.listPersistentVolume(),
    core.listPodForAllNamespaces(),
    storage.listVolumeAttachment(),
    storage.listStorageClass(),
  ]);
  return {
    pvcs: pvcs.items,
    pvs: pvs.items,
    pods: pods.items,
    volumeAttachments: volumeAttachments.items,
    storageClasses: storageClasses.items,
  };
}

export type K8sSnapshot = Awaited<ReturnType<typeof listAll>>;
