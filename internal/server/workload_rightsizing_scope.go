package server

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/cloud"
	"github.com/skyhook-io/radar/internal/k8s"
	"github.com/skyhook-io/radar/internal/prometheus"
	"github.com/skyhook-io/radar/pkg/auth"
	"github.com/skyhook-io/radar/pkg/k8score"
	"github.com/skyhook-io/radar/pkg/resourceid"
	"github.com/skyhook-io/radar/pkg/rightsizing"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"
)

func (s *Server) sizingCaller(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	if !cloud.IsAuthenticatedTunnelRequest(r.Context()) {
		http.NotFound(w, r)
		return false
	}
	if auth.UserFromContext(r.Context()) == nil {
		s.writeErrorCode(w, http.StatusUnauthorized, "workload_metrics_identity_required", "Rightsizing requires an authenticated Hub identity")
		return false
	}
	return true
}

// Only the impersonated caller can authorize access to workload and Pod data through the Hub tunnel.
func (s *Server) handleWorkloadRightsizingScope(w http.ResponseWriter, r *http.Request) {
	if !s.sizingCaller(w, r) {
		return
	}
	kind := k8s.CanonicalWorkloadKind(chi.URLParam(r, "kind"))
	ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
	if !prometheus.IsRightsizingKind(kind) || len(validation.IsDNS1123Label(ns)) != 0 || len(validation.IsDNS1123Subdomain(name)) != 0 {
		s.writeError(w, 400, "Invalid rightsizing workload")
		return
	}
	if outsideNamespacePin(ns) != nil {
		s.writeError(w, 403, "Workload is outside Radar's namespace scope")
		return
	}
	if !s.requireConnected(w) {
		return
	}
	_, generation := k8s.GetClientWithGeneration()
	client, typed := s.getDynamicClientForRequest(r), s.getClientForRequest(r)
	if client == nil || typed == nil {
		s.writeError(w, 503, "Kubernetes is unavailable")
		return
	}
	ctx := r.Context()
	owner, err := client.Resource(appsv1.SchemeGroupVersion.WithResource(prometheus.ScanKindResource(kind))).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		s.writeErrorCode(w, 404, "workload_not_found", "Workload not found")
		return
	}
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		s.writeError(w, 403, "Rightsizing requires access to this workload")
		return
	}
	if err != nil {
		s.writeError(w, 503, "Workload inventory is unavailable")
		return
	}
	scope, template, selector, err := sizingTemplate(kind, owner)
	if err != nil {
		s.writeError(w, 503, "The workload template could not be verified")
		return
	}
	pods, err := verifiedSizingPods(ctx, typed, owner, scope, template, selector)
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) {
		s.writeError(w, 403, "Rightsizing requires permission to list Pods, plus ReplicaSets for Deployments or ControllerRevisions for DaemonSets")
		return
	}
	if errors.Is(err, errSizingAdmission) {
		s.writeErrorCode(w, 409, "pod_resources_changed", "Live Pod resources differ from the workload template. Check admission defaults, a VPA or in-place resizing")
		return
	}
	if errors.Is(err, errSizingLimit) {
		s.writeErrorCode(w, 422, "inventory_limit", "Rightsizing supports up to 512 matching Pods and 512 controller revisions per workload")
		return
	}
	if errors.Is(err, errSizingRollout) {
		s.writeErrorCode(w, 409, "rollout_in_progress", "Rightsizing requires ready replicas running the current workload template")
		return
	}
	if err != nil {
		s.writeError(w, 503, "The complete workload Pod inventory is unavailable")
		return
	}
	scope.Pods = make([]rightsizing.Pod, 0, len(pods))
	scope.CurrentOOM = map[string]bool{}
	for _, p := range pods {
		if p.UID == "" || p.CreationTimestamp.IsZero() {
			s.writeError(w, 503, "Could not verify owned Pod identity")
			return
		}
		pod := rightsizing.Pod{Name: p.Name, UID: string(p.UID), CreatedAt: p.CreationTimestamp.Time, RestartCounts: map[string]int32{}}
		for _, c := range scope.PodSpec.Containers {
			pod.Containers = append(pod.Containers, c.Name)
		}
		for _, c := range scope.PodSpec.InitContainers {
			if c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways {
				pod.Containers = append(pod.Containers, c.Name)
			}
		}
		for _, statuses := range [][]corev1.ContainerStatus{p.Status.ContainerStatuses, p.Status.InitContainerStatuses} {
			for _, c := range statuses {
				if !slices.Contains(pod.Containers, c.Name) {
					continue
				}
				pod.RestartCounts[c.Name] = c.RestartCount
				if (c.LastTerminationState.Terminated != nil && c.LastTerminationState.Terminated.Reason == "OOMKilled") || (c.State.Terminated != nil && c.State.Terminated.Reason == "OOMKilled") {
					scope.CurrentOOM[c.Name] = true
				}
			}
		}
		scope.Pods = append(scope.Pods, pod)
	}
	readSizingHPA(ctx, typed, &scope)
	slices.SortFunc(scope.Pods, func(a, b rightsizing.Pod) int { return cmp.Compare(a.Name, b.Name) })
	scope.ClusterUID, err = cloud.DiscoverClusterUID(ctx, k8s.GetClientInterface())
	if _, current := k8s.GetClientWithGeneration(); current != generation {
		s.writeError(w, 409, "Kubernetes connection changed. Retry the request")
		return
	}
	if err != nil || scope.ClusterUID == "" {
		s.writeError(w, 503, "Could not verify cluster identity")
		return
	}
	s.writeJSON(w, scope)
}

func sizingTemplate(kind string, obj *unstructured.Unstructured) (rightsizing.Scope, corev1.PodTemplateSpec, labels.Selector, error) {
	var t corev1.PodTemplateSpec
	scope := rightsizing.Scope{Kind: kind, Name: obj.GetName(), Namespace: obj.GetNamespace(), WorkloadUID: string(obj.GetUID()), CreatedAt: obj.GetCreationTimestamp().Time, Labels: obj.GetLabels(), ManagedBy: prometheus.DetectWorkloadManager(obj)}
	if scope.WorkloadUID == "" || scope.CreatedAt.IsZero() {
		return scope, t, nil, fmt.Errorf("missing controller identity")
	}
	template, found, err := unstructured.NestedMap(obj.Object, "spec", "template")
	if err != nil || !found {
		return scope, t, nil, fmt.Errorf("missing pod template")
	}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(template, &t); err != nil {
		return scope, t, nil, err
	}
	serialized, err := json.Marshal(template)
	if err != nil {
		return scope, t, nil, err
	}
	sum := sha256.Sum256(serialized)
	scope.TemplateHash = hex.EncodeToString(sum[:])
	scope.PodSpec.Resources = sizingResources(t.Spec.Resources)
	project := func(containers []corev1.Container) []corev1.Container {
		out := make([]corev1.Container, 0, len(containers))
		for _, c := range containers {
			out = append(out, corev1.Container{Name: c.Name, Resources: *sizingResources(&c.Resources), RestartPolicy: c.RestartPolicy})
		}
		return out
	}
	scope.PodSpec.Containers, scope.PodSpec.InitContainers = project(t.Spec.Containers), project(t.Spec.InitContainers)
	var selector metav1.LabelSelector
	m, ok, err := unstructured.NestedMap(obj.Object, "spec", "selector")
	if err != nil || !ok {
		return scope, t, nil, fmt.Errorf("missing controller selector")
	}
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(m, &selector); err != nil {
		return scope, t, nil, err
	}
	parsed, err := metav1.LabelSelectorAsSelector(&selector)
	if err != nil {
		return scope, t, nil, err
	}
	n, ok, err := unstructured.NestedInt64(obj.Object, "spec", "replicas")
	if kind == "DaemonSet" {
		n, _, err = unstructured.NestedInt64(obj.Object, "status", "desiredNumberScheduled")
	} else if !ok {
		n = 1
	}
	if err != nil || n < 0 {
		return scope, t, nil, fmt.Errorf("invalid replica count")
	}
	scope.Replicas = int(n)
	return scope, t, parsed, nil
}

func sizingResources(r *corev1.ResourceRequirements) *corev1.ResourceRequirements {
	if r == nil {
		return nil
	}
	project := func(in corev1.ResourceList) corev1.ResourceList {
		var out corev1.ResourceList
		for _, key := range []corev1.ResourceName{corev1.ResourceCPU, corev1.ResourceMemory} {
			if q, ok := in[key]; ok {
				if out == nil {
					out = corev1.ResourceList{}
				}
				out[key] = q
			}
		}
		return out
	}
	return &corev1.ResourceRequirements{Requests: project(r.Requests), Limits: project(r.Limits)}
}

var (
	errSizingRollout   = errors.New("cannot verify all replicas run the current template")
	errSizingAdmission = errors.New("runtime container resources differ from template")
	errSizingLimit     = errors.New("sizing inventory exceeds limit")
)

// Status describes an earlier observation. Check the live Pods and revision identities too.
func verifiedSizingPods(ctx context.Context, client kubernetes.Interface, owner *unstructured.Unstructured, scope rightsizing.Scope, template corev1.PodTemplateSpec, selector labels.Selector) ([]corev1.Pod, error) {
	opts := metav1.ListOptions{Limit: 513, LabelSelector: selector.String()}
	ns := owner.GetNamespace()
	list, err := client.CoreV1().Pods(ns).List(ctx, opts)
	if err != nil {
		return nil, err
	}
	if list.Continue != "" || len(list.Items) > 512 {
		return nil, errSizingLimit
	}
	if !sizingControllerReady(owner, scope.Kind, scope.Replicas) {
		return nil, errSizingRollout
	}
	revisionLabel, revision := "", ""
	setUIDs := map[types.UID]string{}
	switch scope.Kind {
	case "Deployment":
		sets, err := client.AppsV1().ReplicaSets(ns).List(ctx, opts)
		if err != nil {
			return nil, err
		}
		if sets.Continue != "" || len(sets.Items) > 512 {
			return nil, errSizingLimit
		}
		desired := template.DeepCopy()
		delete(desired.Labels, appsv1.DefaultDeploymentUniqueLabelKey)
		var current []*appsv1.ReplicaSet
		for i := range sets.Items {
			rs := &sets.Items[i]
			if !sizingControllerRef(metav1.GetControllerOf(rs), owner.GetUID(), scope.Kind, scope.Name) {
				continue
			}
			setUIDs[rs.UID] = rs.Name
			template := rs.Spec.Template.DeepCopy()
			delete(template.Labels, appsv1.DefaultDeploymentUniqueLabelKey)
			if equality.Semantic.DeepEqual(*template, *desired) {
				current = append(current, rs)
			}
		}
		revisionLabel, revision = appsv1.DefaultDeploymentUniqueLabelKey, k8score.CurrentDeploymentRevisionPodHashes(current)[owner.GetUID()]
	case "StatefulSet":
		revisionLabel = appsv1.ControllerRevisionHashLabelKey
		revision, _, _ = unstructured.NestedString(owner.Object, "status", "updateRevision")
		applied, _, _ := unstructured.NestedString(owner.Object, "status", "currentRevision")
		if applied != revision {
			return nil, errSizingRollout
		}
	case "DaemonSet":
		revisions, err := client.AppsV1().ControllerRevisions(ns).List(ctx, metav1.ListOptions{Limit: 513})
		if err != nil {
			return nil, err
		}
		if revisions.Continue != "" || len(revisions.Items) > 512 {
			return nil, errSizingLimit
		}
		var records []unstructured.Unstructured
		for i := range revisions.Items {
			r := &revisions.Items[i]
			if !sizingControllerRef(metav1.GetControllerOf(r), owner.GetUID(), scope.Kind, scope.Name) {
				continue
			}
			// Hash resolution only needs metadata and revision, never the recorded Pod template.
			m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(&r.ObjectMeta)
			if err != nil {
				return nil, err
			}
			records = append(records, unstructured.Unstructured{Object: map[string]any{"metadata": m, "revision": r.Revision}})
		}
		revisionLabel, revision = appsv1.ControllerRevisionHashLabelKey, k8score.CurrentControllerRevisionPodHashes(records)[owner.GetUID()]
	}
	pods := make([]corev1.Pod, 0)
	for i := range list.Items {
		p := &list.Items[i]
		if p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed {
			continue
		}
		ref := metav1.GetControllerOf(p)
		if ref == nil {
			continue
		}
		if scope.Kind == "Deployment" {
			if rsName, ok := setUIDs[ref.UID]; !ok || !sizingControllerRef(ref, ref.UID, "ReplicaSet", rsName) {
				continue
			}
		} else if !sizingControllerRef(ref, owner.GetUID(), scope.Kind, scope.Name) {
			continue
		}
		if revision == "" || p.Labels[revisionLabel] != revision || p.DeletionTimestamp != nil || p.Status.Phase != corev1.PodRunning ||
			!slices.ContainsFunc(p.Status.Conditions, func(c corev1.PodCondition) bool { return c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue }) {
			return nil, errSizingRollout
		}
		if !sizingPodMatches(p, template.Spec) {
			return nil, errSizingAdmission
		}
		pods = append(pods, *p)
	}
	if len(pods) != scope.Replicas {
		return nil, errSizingRollout
	}
	return pods, nil
}

func sizingControllerRef(ref *metav1.OwnerReference, uid types.UID, kind, name string) bool {
	return ref != nil && uid != "" && ref.UID == uid && ref.Kind == kind && ref.Name == name && resourceid.GroupFromAPIVersion(ref.APIVersion) == "apps"
}

func sizingControllerReady(owner *unstructured.Unstructured, kind string, desired int) bool {
	generation, _, _ := unstructured.NestedInt64(owner.Object, "status", "observedGeneration")
	if owner.GetDeletionTimestamp() != nil || owner.GetGeneration() < 1 || generation != owner.GetGeneration() {
		return false
	}
	counts := []string{"replicas", "updatedReplicas", "readyReplicas"}
	if kind == "DaemonSet" {
		counts = []string{"currentNumberScheduled", "updatedNumberScheduled", "numberReady"}
	}
	for _, k := range counts {
		n, _, err := unstructured.NestedInt64(owner.Object, "status", k)
		if err != nil || n != int64(desired) {
			return false
		}
	}
	return true
}

func sizingPodMatches(p *corev1.Pod, spec corev1.PodSpec) bool {
	if !equality.Semantic.DeepEqual(sizingResources(p.Spec.Resources), sizingResources(spec.Resources)) {
		return false
	}
	match := func(desired, actual []corev1.Container) bool {
		for _, c := range desired {
			if !slices.ContainsFunc(actual, func(a corev1.Container) bool {
				return c.Name == a.Name && equality.Semantic.DeepEqual(sizingResources(&a.Resources), sizingResources(&c.Resources))
			}) {
				return false
			}
		}
		return true
	}
	return match(spec.Containers, p.Spec.Containers) && match(spec.InitContainers, p.Spec.InitContainers)
}

func readSizingHPA(ctx context.Context, client kubernetes.Interface, scope *rightsizing.Scope) {
	hpas, err := client.AutoscalingV2().HorizontalPodAutoscalers(scope.Namespace).List(ctx, metav1.ListOptions{Limit: 501})
	if err == nil && len(hpas.Items) <= 500 && hpas.Continue == "" {
		scope.HPAEvidenceAvailable = true
		scope.HPAManaged = map[string]bool{}
		for i := range hpas.Items {
			prometheus.AddHPATargetResources(scope.HPAManaged, &hpas.Items[i], scope.Kind, scope.Name)
		}
	}
}
