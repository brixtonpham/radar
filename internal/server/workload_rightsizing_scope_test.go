package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/skyhook-io/radar/internal/cloud"
	"github.com/skyhook-io/radar/pkg/rightsizing"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
	"k8s.io/utils/ptr"
)

func TestRightsizingScopeTunnelAndCaller(t *testing.T) {
	s := &Server{}
	for _, fn := range []http.HandlerFunc{s.handleWorkloadRightsizingScope, s.handleWorkloadRightsizingInventory} {
		for _, tc := range []struct {
			h    http.Handler
			want int
		}{{fn, 404}, {cloud.AuthenticatedTunnelHandler(fn), 401}} {
			w := httptest.NewRecorder()
			req := httptest.NewRequest("GET", "/api/agent/test", nil)
			req.Header.Set("X-Forwarded-User", "owner")
			tc.h.ServeHTTP(w, req)
			if w.Code != tc.want || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("got %d %#v", w.Code, w.Header())
			}
		}
	}
}

func TestSizingInventoryExactReads(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := appsv1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	meta := metav1.ObjectMeta{Name: "hidden", Namespace: "team"}
	client := dynamicfake.NewSimpleDynamicClient(scheme, &appsv1.Deployment{ObjectMeta: meta}, &appsv1.StatefulSet{ObjectMeta: meta}, &appsv1.DaemonSet{ObjectMeta: metav1.ObjectMeta{Name: "ok", Namespace: "team"}})
	deny := func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(a.GetResource().GroupResource(), "", nil)
	}
	client.PrependReactor("get", "statefulsets", deny)
	client.PrependReactor("list", "replicasets", deny)
	got := readSizingInventory(t.Context(), client, []string{"team"})
	if got.Partial || len(got.Items) != 1 || got.Items[0].Name != "ok" {
		t.Fatal(got)
	}
	client.PrependReactor("list", "pods", deny)
	got = readSizingInventory(t.Context(), client, []string{"team"})
	if got.Partial || len(got.Items) != 0 {
		t.Fatal(got)
	}
}

func TestSizingTemplateAndCurrentReplicaGuards(t *testing.T) {
	container := corev1.Container{Name: "api", Image: "api:v2", Env: []corev1.EnvVar{{Name: "TOKEN", Value: "sensitive-example"}}}
	owner := appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api", UID: "controller", Generation: 2, CreationTimestamp: metav1.NewTime(time.Now())},
		Spec:       appsv1.StatefulSetSpec{Replicas: ptr.To[int32](1), Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}, Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{container}}}},
		Status:     appsv1.StatefulSetStatus{Replicas: 1, ReadyReplicas: 1, UpdatedReplicas: 1, ObservedGeneration: 2, UpdateRevision: "new", CurrentRevision: "new"},
	}
	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "api-0", UID: "pod-new", OwnerReferences: []metav1.OwnerReference{*metav1.NewControllerRef(&owner, appsv1.SchemeGroupVersion.WithKind("StatefulSet"))}, Labels: map[string]string{"app": "api", appsv1.ControllerRevisionHashLabelKey: "new"}},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{container}},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}},
	}
	for _, tc := range []struct {
		name   string
		change func(*appsv1.StatefulSet, *corev1.Pod)
	}{
		{"stable", func(*appsv1.StatefulSet, *corev1.Pod) {}},
		{"unobserved", func(sts *appsv1.StatefulSet, _ *corev1.Pod) { sts.Generation++ }},
		{"partition", func(sts *appsv1.StatefulSet, _ *corev1.Pod) { sts.Status.CurrentRevision = "old" }},
		{"partial", func(sts *appsv1.StatefulSet, _ *corev1.Pod) { sts.Status.UpdatedReplicas = 0 }},
		{"old pod", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.Labels[appsv1.ControllerRevisionHashLabelKey] = "old" }},
		{"old image", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.Spec.Containers[0].Image = "api:v1" }},
		{"missing container", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.Spec.Containers = nil }},
		{"not ready", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.Status.Conditions = nil }},
		{"different group", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.OwnerReferences[0].APIVersion = "test.example/v1" }},
		{"different UID", func(_ *appsv1.StatefulSet, p *corev1.Pod) { p.OwnerReferences[0].UID = "recreated" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sts, p := owner.DeepCopy(), pod.DeepCopy()
			tc.change(sts, p)
			m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(sts)
			if err != nil {
				t.Fatal(err)
			}
			u := &unstructured.Unstructured{Object: m}
			scope, tmpl, sel, err := sizingTemplate("StatefulSet", u)
			if err != nil {
				t.Fatal(err)
			}
			wire, err := json.Marshal(scope)
			if err != nil || strings.Contains(string(wire), "sensitive-example") || len(scope.TemplateHash) != 64 {
				t.Fatalf("unsafe projection or missing hash")
			}
			pods, err := verifiedSizingPods(t.Context(), fake.NewSimpleClientset(p), u, scope, tmpl, sel)
			if tc.name == "stable" {
				if err != nil || len(pods) != 1 {
					t.Fatalf("got %v, %v", pods, err)
				}
			} else if !errors.Is(err, errSizingRollout) {
				t.Fatalf("want rollout conflict, got %v", err)
			}
		})
	}
}

func TestRightsizingScopeReadHPAAsCaller(t *testing.T) {
	hpa := &autoscalingv2.HorizontalPodAutoscaler{ObjectMeta: metav1.ObjectMeta{Namespace: "team", Name: "scaler"}, Spec: autoscalingv2.HorizontalPodAutoscalerSpec{ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{APIVersion: "apps/v1", Kind: "Deployment", Name: "api"}, Metrics: []autoscalingv2.MetricSpec{{Type: autoscalingv2.ContainerResourceMetricSourceType, ContainerResource: &autoscalingv2.ContainerResourceMetricSource{Name: corev1.ResourceCPU, Container: "api", Target: autoscalingv2.MetricTarget{Type: autoscalingv2.UtilizationMetricType, AverageUtilization: ptr.To[int32](70)}}}}}}
	client := fake.NewSimpleClientset(hpa)
	scope := rightsizing.Scope{Kind: "Deployment", Namespace: "team", Name: "api"}
	readSizingHPA(t.Context(), client, &scope)
	if !scope.HPAEvidenceAvailable || !scope.HPAManaged.Controls("api", "cpu") || scope.HPAManaged.Controls("logger", "cpu") || scope.HPAManaged.Controls("api", "memory") {
		t.Fatalf("unexpected HPA guard: %#v", scope)
	}
	client.PrependReactor("list", "horizontalpodautoscalers", func(a k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(a.GetResource().GroupResource(), "", nil)
	})
	denied := rightsizing.Scope{Kind: "Deployment", Namespace: "team", Name: "api"}
	readSizingHPA(t.Context(), client, &denied)
	if denied.HPAEvidenceAvailable || len(denied.HPAManaged) > 0 {
		t.Fatalf("HPA facts leaked to denied caller")
	}
}

func TestRightsizingScopeDeploymentRejectsStaleReplicaSet(t *testing.T) {
	template := corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "api"}}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "api", Image: "api:v1"}}}}
	dep := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{UID: "dep", Namespace: "team", Name: "api", Generation: 1, CreationTimestamp: metav1.Now()}, Spec: appsv1.DeploymentSpec{Replicas: ptr.To[int32](1), Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "api"}}, Template: template}, Status: appsv1.DeploymentStatus{Replicas: 1, ReadyReplicas: 1, UpdatedReplicas: 1, ObservedGeneration: 1}}
	rs := &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{UID: "rs", Name: "api-123", Namespace: "team", Labels: map[string]string{"app": "api", appsv1.DefaultDeploymentUniqueLabelKey: "123"}, Annotations: map[string]string{"deployment.kubernetes.io/revision": "1"}, OwnerReferences: []metav1.OwnerReference{*metav1.NewControllerRef(dep, appsv1.SchemeGroupVersion.WithKind("Deployment"))}}, Spec: appsv1.ReplicaSetSpec{Template: *template.DeepCopy()}}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{UID: "pod", Name: "api-123-one", Namespace: "team", Labels: rs.Labels, OwnerReferences: []metav1.OwnerReference{*metav1.NewControllerRef(rs, appsv1.SchemeGroupVersion.WithKind("ReplicaSet"))}}, Spec: *template.Spec.DeepCopy(), Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}}}
	for _, changed := range []bool{false, true} {
		if changed {
			dep.Spec.Template.Spec.Containers[0].Args = []string{"--more-workers"}
		}
		m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(dep)
		if err != nil {
			t.Fatal(err)
		}
		obj := &unstructured.Unstructured{Object: m}
		scope, tmpl, selector, err := sizingTemplate("Deployment", obj)
		if err != nil {
			t.Fatal(err)
		}
		pods, err := verifiedSizingPods(t.Context(), fake.NewSimpleClientset(rs, pod), obj, scope, tmpl, selector)
		if changed && !errors.Is(err, errSizingRollout) {
			t.Fatalf("stale ReplicaSet accepted: %#v %v", pods, err)
		}
		if !changed && (err != nil || len(pods) != 1) {
			t.Fatalf("current ReplicaSet rejected: %v", err)
		}
	}
}
