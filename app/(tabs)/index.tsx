import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useRef, useState } from "react";
import { router } from "expo-router";
import { trpc } from "@/lib/trpc";
import { getApiBaseUrl } from "@/constants/oauth";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { formatTime } from "@/lib/workout-utils";
import { filterExerciseCatalog, resolveExerciseMetadata } from "@/lib/exercise-utils";
import {
  EQUIPMENT_CATALOG,
  EXERCISE_CATALOG,
  MUSCLE_GROUPS,
} from "@/lib/exercise-catalog";
import {
  ensureNotificationPermission,
  scheduleRestEndNotification,
  cancelNotification,
} from "@/lib/notifications";
import * as Sharing from "expo-sharing";

const STORAGE_KEY = "treino-local-workouts-v1";
const DAY_LABELS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

type Exercise = {
  id: string;
  name: string;
  muscleGroup: string;
  equipment: string;
  sets: number;
  reps: number;
  restSeconds: number;
  loadKg: number;
};

type Workout = {
  id: string;
  name: string;
  exercises: Exercise[];
  updatedAt: string;
  // Days of week this workout is scheduled for: 0 = Domingo ... 6 = Sábado.
  // Empty array = sem dia definido (treino avulso).
  daysOfWeek: number[];
  lastCompletedAt?: string;
};

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function daysLabel(days: number[] | undefined) {
  if (!days || days.length === 0) return "Sem dia definido";
  if (days.length === 7) return "Todos os dias";
  return [...days].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join(" · ");
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function nextWorkoutScore(workout: Workout, now = new Date()) {
  const days = workout.daysOfWeek ?? [];
  if (days.length === 0) return 100 + (workout.lastCompletedAt ? new Date(workout.lastCompletedAt).getTime() / 1e12 : 0);
  const completedToday = workout.lastCompletedAt ? localDayKey(new Date(workout.lastCompletedAt)) === localDayKey(now) : false;
  const today = now.getDay();
  const distances = days.map((day) => {
    const distance = (day - today + 7) % 7;
    return distance === 0 && completedToday ? 7 : distance;
  });
  const nearest = Math.min(...distances);
  const completionTieBreaker = workout.lastCompletedAt ? new Date(workout.lastCompletedAt).getTime() / 1e12 : -1;
  return nearest * 100 + completionTieBreaker;
}

function sortWorkoutsForNextSession(workouts: Workout[]) {
  return [...workouts].sort((a, b) => nextWorkoutScore(a) - nextWorkoutScore(b));
}

export default function HomeScreen() {
  const colors = useColors();
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingWorkout, setEditingWorkout] = useState<Workout | null>(null);
  const [selectedWorkout, setSelectedWorkout] = useState<Workout | null>(null);
  const [activeWorkout, setActiveWorkout] = useState<Workout | null>(null);
  const cloudEnabled = Boolean(getApiBaseUrl());
  const backupPull = trpc.appBackup.pull.useQuery(undefined, { enabled: cloudEnabled, retry: false });
  const backupPush = trpc.appBackup.pushWorkouts.useMutation();
  const [cloudHydrated, setCloudHydrated] = useState(!cloudEnabled);

  useEffect(() => {
    ensureNotificationPermission();
    AsyncStorage.getItem(STORAGE_KEY).then((value) => {
      if (value) {
        const parsed: Workout[] = JSON.parse(value);
        // Backfill daysOfWeek for workouts saved before this field existed.
        setWorkouts(sortWorkoutsForNextSession(parsed.map((w) => ({
          ...w,
          daysOfWeek: w.daysOfWeek ?? [],
          exercises: w.exercises.map((exercise) => ({
            ...exercise,
            muscleGroup: exercise.muscleGroup ?? "Outros",
            equipment: exercise.equipment ?? "Peso do corpo",
          })),
        }))));
      }
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!cloudEnabled || !backupPull.data || !backupPull.data.payload) { if (!backupPull.isLoading) setCloudHydrated(true); return; }
    try {
      const cloud = JSON.parse(backupPull.data.payload);
      if (Array.isArray(cloud.workouts)) setWorkouts(cloud.workouts);
    } catch { /* keep local data when cloud payload is invalid */ }
    setCloudHydrated(true);
  }, [backupPull.data, backupPull.isLoading, cloudEnabled]);

  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(workouts));
    if (hydrated && cloudHydrated && cloudEnabled) {
      const timer = setTimeout(() => backupPush.mutate({ workouts: JSON.stringify(workouts) }), 700);
      return () => clearTimeout(timer);
    }
  }, [workouts, hydrated]);

  const totalExercises = useMemo(() => workouts.reduce((sum, workout) => sum + workout.exercises.length, 0), [workouts]);

  const saveWorkout = (workout: Workout) => {
    setWorkouts((current) => {
      const exists = current.some((item) => item.id === workout.id);
      return exists ? current.map((item) => (item.id === workout.id ? { ...workout, lastCompletedAt: item.lastCompletedAt } : item)) : [workout, ...current];
    });
    setSelectedWorkout(workout);
    setEditingWorkout(null);
    setEditorVisible(false);
  };

  const removeWorkout = (workout: Workout) => Alert.alert("Excluir treino?", `“${workout.name}” será removido deste aparelho.`, [
    { text: "Cancelar", style: "cancel" },
    { text: "Excluir", style: "destructive", onPress: () => { setWorkouts((items) => items.filter((item) => item.id !== workout.id)); setSelectedWorkout(null); } },
  ]);

  // Reordering: move a workout up (-1) or down (+1) in the list. The saved
  // array order IS the display order, so this is all persistence needs.
  const moveWorkout = (id: string, direction: -1 | 1) => {
    setWorkouts((current) => {
      const index = current.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const copy = [...current];
      const [item] = copy.splice(index, 1);
      copy.splice(nextIndex, 0, item);
      return copy;
    });
  };

  if (activeWorkout) return <WorkoutRunner workout={activeWorkout} onClose={(updated, completed) => { setWorkouts((items) => { const next = items.map((item) => item.id === updated.id ? { ...updated, lastCompletedAt: completed ? new Date().toISOString() : item.lastCompletedAt } : item); return completed ? sortWorkoutsForNextSession(next) : next; }); setActiveWorkout(null); }} colors={colors} />;
  if (selectedWorkout) return <WorkoutDetail workout={selectedWorkout} onBack={() => setSelectedWorkout(null)} onEdit={() => { setEditingWorkout(selectedWorkout); setSelectedWorkout(null); setEditorVisible(true); }} onDelete={() => removeWorkout(selectedWorkout)} onStart={() => setActiveWorkout(selectedWorkout)} colors={colors} />;

  return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <ScrollView style={styles.homeScroll} contentContainerStyle={styles.homeContent} showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>MYTREINOPRO</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>Sua carga.{"\n"}Seu treino.</Text>
        </View>
        <View style={[styles.headerBadge, { backgroundColor: colors.surface }]}><Image source={require("@/assets/images/mytreinopro-symbol-small.png")} style={styles.headerLogo} accessibilityLabel="Logo MyTreinoPRO" /></View>
      </View>
      <View style={[styles.statsCard, { backgroundColor: colors.primary }]}>
        <View><Text style={styles.statsLabel}>RESUMO</Text><Text style={styles.statsTitle}>{workouts.length === 0 ? "Comece pelo seu primeiro treino" : `${workouts.length} treino${workouts.length === 1 ? "" : "s"} preparado${workouts.length === 1 ? "" : "s"}`}</Text></View>
        <View style={styles.statPill}><Text style={styles.statNumber}>{totalExercises}</Text><Text style={styles.statCaption}>exercícios</Text></View>
      </View>
      <View style={styles.moduleRow}>
        <Pressable onPress={() => router.push("/personalized")} style={[styles.moduleCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><IconSymbol name="sparkles" size={23} color={colors.primary} /><Text style={[styles.moduleTitle, { color: colors.foreground }]}>Treino personalizado</Text><Text style={[styles.moduleText, { color: colors.muted }]}>Sugestão pelo seu perfil</Text></Pressable>
        <Pressable onPress={() => router.push("/evolution")} style={[styles.moduleCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><IconSymbol name="chart.line.uptrend.xyaxis" size={23} color={colors.primary} /><Text style={[styles.moduleTitle, { color: colors.foreground }]}>Evolução</Text><Text style={[styles.moduleText, { color: colors.muted }]}>Acompanhe suas medidas</Text></Pressable>
      </View>
      <View style={styles.sectionHeader}><View><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Meus treinos</Text><Text style={[styles.sectionSubtitle, { color: colors.muted }]}>{workouts.length ? "Escolha uma sessão para começar" : "Monte uma sessão do seu jeito"}</Text></View><Pressable onPress={() => { setEditingWorkout(null); setEditorVisible(true); }} style={({ pressed }) => [styles.addButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}><IconSymbol name="plus" size={20} color="#FFFFFF" /></Pressable></View>
      {workouts.length === 0 ? <EmptyState colors={colors} onCreate={() => setEditorVisible(true)} /> : (
        <View style={styles.listContent}>
          {workouts.map((item, index) => (
            <WorkoutCard
              key={item.id}
              workout={item}
              colors={colors}
              onPress={() => setSelectedWorkout(item)}
              onMoveUp={index > 0 ? () => moveWorkout(item.id, -1) : undefined}
              onMoveDown={index < workouts.length - 1 ? () => moveWorkout(item.id, 1) : undefined}
            />
          ))}
        </View>
      )}
      <View style={styles.footer}><IconSymbol name="lock.fill" size={15} color={colors.muted} /><Text style={[styles.footerText, { color: colors.muted }]}>Seus dados ficam somente neste aparelho</Text></View>
      </ScrollView>
      <WorkoutEditor visible={editorVisible} initialWorkout={editingWorkout} colors={colors} onClose={() => { setEditorVisible(false); setEditingWorkout(null); }} onSave={saveWorkout} />
    </ScreenContainer>
  );
}

function EmptyState({ colors, onCreate }: { colors: any; onCreate: () => void }) { return <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.emptyIcon, { backgroundColor: colors.primary + "18" }]}><IconSymbol name="dumbbell.fill" size={30} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>Ainda não há treinos</Text><Text style={[styles.emptyText, { color: colors.muted }]}>Crie uma rotina com seus exercícios, séries, repetições e cargas.</Text><Pressable onPress={onCreate} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}><IconSymbol name="plus" size={18} color="#FFF" /><Text style={styles.primaryButtonText}>Criar primeiro treino</Text></Pressable></View> }

function WorkoutCard({
  workout,
  colors,
  onPress,
  onMoveUp,
  onMoveDown,
}: {
  workout: Workout;
  colors: any;
  onPress: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}) {
  const duration = workout.exercises.reduce((sum, item) => sum + item.sets * item.restSeconds, 0);
  return (
    <View style={[styles.workoutCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable onPress={onPress} style={({ pressed }) => [styles.workoutCardMain, pressed && { opacity: 0.75 }]}>
        <View style={[styles.cardIcon, { backgroundColor: colors.primary + "18" }]}><IconSymbol name="dumbbell.fill" size={22} color={colors.primary} /></View>
        <View style={styles.cardCopy}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{workout.name}</Text>
          <Text style={[styles.cardMeta, { color: colors.muted }]}>{workout.exercises.length} {workout.exercises.length === 1 ? "exercício" : "exercícios"}  ·  {Math.max(1, Math.round(duration / 60))} min estimados</Text>
          <Text style={[styles.cardDays, { color: colors.primary }]}>{daysLabel(workout.daysOfWeek)}</Text>
        </View>
        <IconSymbol name="chevron.right" size={20} color={colors.muted} />
      </Pressable>
      {(onMoveUp || onMoveDown) && (
        <View style={styles.reorderColumn}>
          <Pressable disabled={!onMoveUp} onPress={onMoveUp} style={[styles.reorderButton, !onMoveUp && styles.reorderButtonDisabled]}>
            <IconSymbol name="chevron.up" size={16} color={onMoveUp ? colors.foreground : colors.border} />
          </Pressable>
          <Pressable disabled={!onMoveDown} onPress={onMoveDown} style={[styles.reorderButton, !onMoveDown && styles.reorderButtonDisabled]}>
            <IconSymbol name="chevron.down" size={16} color={onMoveDown ? colors.foreground : colors.border} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

function WorkoutDetail({ workout, onBack, onEdit, onDelete, onStart, colors }: { workout: Workout; onBack: () => void; onEdit: () => void; onDelete: () => void; onStart: () => void; colors: any }) {
  return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <View style={styles.detailTop}><Pressable onPress={onBack} style={styles.iconButton}><IconSymbol name="chevron.left" size={24} color={colors.foreground} /></Pressable><Text style={[styles.detailTopTitle, { color: colors.foreground }]}>Detalhes</Text><Pressable onPress={onEdit} style={styles.editWorkoutButton}><IconSymbol name="pencil" size={17} color={colors.primary} /><Text style={[styles.editWorkoutText, { color: colors.primary }]}>Editar treino</Text></Pressable></View>
      <Text style={[styles.detailTitle, { color: colors.foreground }]}>{workout.name}</Text>
      <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>{workout.exercises.length} exercícios · pronto para começar</Text>
      <Text style={[styles.detailDays, { color: colors.primary }]}>{daysLabel(workout.daysOfWeek)}</Text>
      <FlatList data={workout.exercises} keyExtractor={(item) => item.id} contentContainerStyle={{ paddingVertical: 22, gap: 10 }} renderItem={({ item, index }) => <View style={[styles.detailExercise, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.indexCircle, { backgroundColor: colors.primary }]}><Text style={styles.indexText}>{index + 1}</Text></View><View style={{ flex: 1 }}><Text style={[styles.exerciseName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.cardMeta, { color: colors.muted }]}>{item.muscleGroup} · {item.equipment} · {item.sets} séries × {item.reps} reps · {item.loadKg ? `${item.loadKg} kg` : "sem carga"}</Text></View><Text style={[styles.restText, { color: colors.primary }]}>{formatTime(item.restSeconds)}</Text></View>} />
      <Pressable onPress={onStart} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}><IconSymbol name="play.fill" size={19} color="#FFF" /><Text style={styles.primaryButtonText}>Iniciar treino</Text></Pressable>
      <Pressable onPress={onDelete} style={styles.deleteButton}><Text style={[styles.deleteText, { color: colors.error }]}>Excluir treino</Text></Pressable>
    </ScreenContainer>
  );
}

function WorkoutEditor({ visible, initialWorkout, colors, onClose, onSave }: { visible: boolean; initialWorkout: Workout | null; colors: any; onClose: () => void; onSave: (workout: Workout) => void }) {
  const [name, setName] = useState("");
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [days, setDays] = useState<number[]>([]);
  const [exerciseName, setExerciseName] = useState("");
  const [selectedMuscleGroup, setSelectedMuscleGroup] = useState<string>(MUSCLE_GROUPS[0]);
  const [equipment, setEquipment] = useState<string>("Peso do corpo");
  const [editingExerciseId, setEditingExerciseId] = useState<string | null>(null);
  const [sets, setSets] = useState("3");
  const [reps, setReps] = useState("10");
  const [rest, setRest] = useState("60");
  const [load, setLoad] = useState("");

  useEffect(() => {
    setName(initialWorkout?.name ?? "");
    setExercises((initialWorkout?.exercises ?? []).map((exercise) => ({
      ...exercise,
      muscleGroup: exercise.muscleGroup ?? "Outros",
      equipment: exercise.equipment ?? "Peso do corpo",
    })));
    setDays(initialWorkout?.daysOfWeek ?? []);
    setExerciseName("");
    setSelectedMuscleGroup(MUSCLE_GROUPS[0]);
    setEquipment("Peso do corpo");
    setEditingExerciseId(null);
  }, [initialWorkout, visible]);

  const toggleDay = (day: number) => {
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));
  };

  const addExercise = () => {
    if (!exerciseName.trim()) return;
    const metadata = resolveExerciseMetadata(EXERCISE_CATALOG, exerciseName, selectedMuscleGroup, equipment);
    const nextExercise: Exercise = {
      id: editingExerciseId ?? uid(),
      name: exerciseName.trim(),
      muscleGroup: metadata.muscleGroup,
      equipment: metadata.equipment,
      sets: Math.max(1, Number(sets) || 1),
      reps: Math.max(1, Number(reps) || 1),
      restSeconds: Math.max(0, Number(rest) || 0),
      loadKg: Math.max(0, Number(load.replace(",", ".")) || 0),
    };
    setExercises((items) => editingExerciseId ? items.map((item) => item.id === editingExerciseId ? nextExercise : item) : [...items, nextExercise]);
    setExerciseName("");
    setLoad("");
    setEditingExerciseId(null);
  };

  const editExercise = (item: Exercise) => {
    setEditingExerciseId(item.id);
    setExerciseName(item.name);
    setSelectedMuscleGroup(item.muscleGroup);
    setEquipment(item.equipment);
    setSets(String(item.sets));
    setReps(String(item.reps));
    setRest(String(item.restSeconds));
    setLoad(item.loadKg ? String(item.loadKg) : "");
  };

  const moveExercise = (id: string, direction: -1 | 1) => {
    setExercises((items) => {
      const index = items.findIndex((item) => item.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= items.length) return items;
      const copy = [...items];
      const [item] = copy.splice(index, 1);
      copy.splice(nextIndex, 0, item);
      return copy;
    });
  };

  const save = () => {
    if (!name.trim() || exercises.length === 0) {
      Alert.alert("Complete seu treino", "Dê um nome e adicione pelo menos um exercício.");
      return;
    }
    onSave({ id: initialWorkout?.id ?? uid(), name: name.trim(), exercises, daysOfWeek: days, updatedAt: new Date().toISOString() });
  };

  const suggestions = filterExerciseCatalog(EXERCISE_CATALOG, exerciseName, selectedMuscleGroup);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose}><Text style={[styles.modalCancel, { color: colors.muted }]}>Cancelar</Text></Pressable>
          <Text style={[styles.modalTitle, { color: colors.foreground }]}>{initialWorkout ? "Editar treino" : "Novo treino"}</Text>
          <Pressable onPress={save}><Text style={[styles.modalSave, { color: colors.primary }]}>Salvar</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.editorContent} keyboardShouldPersistTaps="handled">
          <Text style={[styles.inputLabel, { color: colors.muted }]}>NOME DO TREINO</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Ex.: Peito e tríceps" placeholderTextColor={colors.muted} style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} returnKeyType="done" />

          <Text style={[styles.inputLabel, { color: colors.muted, marginTop: 22 }]}>DIAS DA SEMANA</Text>
          <View style={styles.daysRow}>
            {DAY_LABELS.map((label, index) => {
              const active = days.includes(index);
              return (
                <Pressable
                  key={label}
                  onPress={() => toggleDay(index)}
                  style={[styles.dayChip, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? colors.primary : colors.surface }]}
                >
                  <Text style={[styles.dayChipText, { color: active ? "#FFF" : colors.foreground }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.inputLabel, { color: colors.muted, marginTop: 22 }]}>EXERCÍCIOS {exercises.length ? `(${exercises.length})` : ""}</Text>
          {exercises.map((item, index) => (
            <View key={item.id} style={[styles.editorExercise, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.exerciseName, { color: colors.foreground }]}>{index + 1}. {item.name}</Text>
                <Text style={[styles.cardMeta, { color: colors.muted }]}>{item.muscleGroup} · {item.equipment} · {item.sets} séries × {item.reps} reps · {item.loadKg || 0} kg · descanso {formatTime(item.restSeconds)}</Text>
              </View>
              <View style={styles.exerciseActions}>
                <Pressable onPress={() => moveExercise(item.id, -1)} disabled={index === 0}><IconSymbol name="chevron.up" size={18} color={index === 0 ? colors.border : colors.foreground} /></Pressable>
                <Pressable onPress={() => moveExercise(item.id, 1)} disabled={index === exercises.length - 1}><IconSymbol name="chevron.down" size={18} color={index === exercises.length - 1 ? colors.border : colors.foreground} /></Pressable>
                <Pressable onPress={() => editExercise(item)}><IconSymbol name="pencil" size={18} color={colors.primary} /></Pressable>
                <Pressable onPress={() => setExercises((items) => items.filter((exercise) => exercise.id !== item.id))}><IconSymbol name="trash" size={18} color={colors.error} /></Pressable>
              </View>
            </View>
          ))}
          <View style={[styles.addExerciseBox, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Text style={[styles.addExerciseTitle, { color: colors.foreground }]}>Adicionar exercício</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7, paddingBottom: 12 }}>
              {MUSCLE_GROUPS.map((group) => <Pressable key={group} onPress={() => setSelectedMuscleGroup(group)} style={[styles.suggestionChip, { borderColor: selectedMuscleGroup === group ? colors.primary : colors.border, backgroundColor: selectedMuscleGroup === group ? colors.primary : "transparent" }]}><Text style={[styles.suggestionText, { color: selectedMuscleGroup === group ? "#FFF" : colors.primary }]}>{group}</Text></Pressable>)}
            </ScrollView>
            <TextInput value={exerciseName} onChangeText={setExerciseName} placeholder="Nome do exercício" placeholderTextColor={colors.muted} style={[styles.smallInput, { color: colors.foreground, borderColor: colors.border }]} returnKeyType="done" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7, paddingBottom: 13 }}>
              {suggestions.map((item) => <Pressable key={`${item.name}-${item.equipment}`} onPress={() => { setExerciseName(item.name); setSelectedMuscleGroup(item.muscleGroup); setEquipment(item.equipment); }} style={[styles.suggestionChip, { borderColor: colors.border }]}><Text style={[styles.suggestionText, { color: colors.primary }]}>{item.name} · {item.equipment}</Text></Pressable>)}
            </ScrollView>
            <Text style={[styles.miniLabel, { color: colors.muted }]}>EQUIPAMENTO</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 7, paddingBottom: 13 }}>
              {EQUIPMENT_CATALOG.map((item) => <Pressable key={item} onPress={() => setEquipment(item)} style={[styles.suggestionChip, { borderColor: equipment === item ? colors.primary : colors.border, backgroundColor: equipment === item ? colors.primary : "transparent" }]}><Text style={[styles.suggestionText, { color: equipment === item ? "#FFF" : colors.primary }]}>{item}</Text></Pressable>)}
            </ScrollView>
            <View style={styles.inputRow}>
              <NumberInput value={sets} onChangeText={setSets} label="Séries" colors={colors} />
              <NumberInput value={reps} onChangeText={setReps} label="Reps" colors={colors} />
              <NumberInput value={rest} onChangeText={setRest} label="Descanso (s)" colors={colors} />
              <NumberInput value={load} onChangeText={setLoad} label="Carga (kg)" colors={colors} />
            </View>
            <Pressable onPress={addExercise} style={({ pressed }) => [styles.outlineButton, { borderColor: colors.primary }, pressed && styles.pressed]}><IconSymbol name={editingExerciseId ? "checkmark" : "plus"} size={18} color={colors.primary} /><Text style={[styles.outlineButtonText, { color: colors.primary }]}>{editingExerciseId ? "Salvar alterações" : "Adicionar à lista"}</Text></Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function NumberInput({ value, onChangeText, label, colors }: { value: string; onChangeText: (value: string) => void; label: string; colors: any }) { return <View style={{ flex: 1 }}><Text style={[styles.miniLabel, { color: colors.muted }]}>{label}</Text><TextInput value={value} onChangeText={onChangeText} keyboardType="decimal-pad" style={[styles.numberInput, { color: colors.foreground, borderColor: colors.border }]} /></View> }

function WorkoutRunner({ workout, onClose, colors }: { workout: Workout; onClose: (workout: Workout, completed?: boolean) => void; colors: any }) {
  const [exerciseIndex, setExerciseIndex] = useState(0);
  const [setIndex, setSetIndex] = useState(0);
  const [remaining, setRemaining] = useState(workout.exercises[0]?.restSeconds ?? 0);
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [finished, setFinished] = useState(false);
  const [reportUri, setReportUri] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [bodyWeightKg, setBodyWeightKg] = useState(70);
  const reportRef = useRef<View>(null);
  const startedAt = useRef(Date.now());
  const exercise = workout.exercises[exerciseIndex];
  const durationSeconds = Math.max(60, Math.round((Date.now() - startedAt.current) / 1000));
  const estimatedCalories = Math.max(1, Math.round(bodyWeightKg * 6 * (durationSeconds / 3600)));

  useEffect(() => {
    AsyncStorage.getItem("treino-local-evolution-v1").then((raw) => {
      if (!raw) return;
      try {
        const records = JSON.parse(raw);
        const latest = [...records].reverse().find((record: any) => typeof record.weightKg === "number" && record.weightKg > 0);
        if (latest) setBodyWeightKg(latest.weightKg);
      } catch { /* use the conservative 70 kg reference */ }
    });
  }, []);

  // Real-world timestamp the countdown should reach zero at. Because this is a
  // fixed point in time (not a tick counter), the displayed value is always
  // recomputed from `Date.now()` — so it can never "freeze" while the app is
  // backgrounded. When the app comes back to the foreground we just recompute
  // once immediately instead of waiting for the interval's next tick.
  const endAtRef = useRef<number | null>(null);
  const notificationIdRef = useRef<string | null>(null);

  const recomputeRemaining = () => {
    if (endAtRef.current == null) return;
    const diff = Math.max(0, Math.ceil((endAtRef.current - Date.now()) / 1000));
    setRemaining(diff);
    if (diff <= 0) {
      setRunning(false);
      endAtRef.current = null;
    }
  };

  // Drive the countdown from the wall clock while running.
  useEffect(() => {
    if (!running) return;
    if (endAtRef.current == null) {
      endAtRef.current = Date.now() + remaining * 1000;
      scheduleRestEndNotification(remaining, exercise?.name ?? "Treino").then((id) => {
        notificationIdRef.current = id;
      });
    }
    const interval = setInterval(recomputeRemaining, 250);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Recompute immediately when returning from background (fixes the "frozen"
  // display) instead of trusting whatever the last background tick left behind.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") recomputeRemaining();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return () => {
      cancelNotification(notificationIdRef.current);
    };
  }, []);

  const togglePlay = () => {
    if (running) {
      // Pausing: stop trusting the old end time and cancel the pending
      // notification so it doesn't fire while the timer is paused.
      cancelNotification(notificationIdRef.current);
      notificationIdRef.current = null;
      endAtRef.current = null;
      setRunning(false);
    } else {
      setRunning(true);
    }
  };

  const resetTimer = () => {
    cancelNotification(notificationIdRef.current);
    notificationIdRef.current = null;
    endAtRef.current = null;
    setRunning(false);
    setRemaining(exercise.restSeconds);
  };

  const skipTimer = () => {
    cancelNotification(notificationIdRef.current);
    notificationIdRef.current = null;
    endAtRef.current = null;
    setRunning(false);
    setRemaining(0);
  };

  const goToRest = (seconds: number, autoStart: boolean) => {
    cancelNotification(notificationIdRef.current);
    notificationIdRef.current = null;
    endAtRef.current = null;
    setRemaining(seconds);
    setRunning(autoStart && seconds > 0);
  };

  const completeSet = () => {
    const nextCompleted = completed + 1;
    setCompleted(nextCompleted);
    if (setIndex + 1 < exercise.sets) {
      setSetIndex(setIndex + 1);
      goToRest(exercise.restSeconds, exercise.restSeconds > 0);
    } else if (exerciseIndex + 1 < workout.exercises.length) {
      setExerciseIndex(exerciseIndex + 1);
      setSetIndex(0);
      goToRest(workout.exercises[exerciseIndex + 1].restSeconds, false);
    } else {
      cancelNotification(notificationIdRef.current);
      setFinished(true);
    }
  };

  const finish = () => {
    const updatedExercise = { ...exercise, loadKg: exercise.loadKg };
    const updated = { ...workout, exercises: workout.exercises.map((item, index) => index === exerciseIndex ? updatedExercise : item), updatedAt: new Date().toISOString() };
    onClose(updated, true);
  };

  const captureReport = async () => {
    if (!reportRef.current) return null;
    setCapturing(true);
    try {
      const { captureRef } = await import("react-native-view-shot");
      const uri = await captureRef(reportRef, { format: "png", quality: 1, result: "tmpfile", width: 1080, height: 1920 });
      setReportUri(uri);
      return uri;
    } finally {
      setCapturing(false);
    }
  };

  const shareReport = async () => {
    try {
      const uri = reportUri ?? await captureReport();
      if (!uri) return;
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert("Compartilhamento indisponível", "O compartilhamento nativo não está disponível neste dispositivo.");
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Compartilhar relatório do MyTreinoPRO", UTI: "public.png" });
    } catch (error) {
      Alert.alert("Não foi possível compartilhar", error instanceof Error ? error.message : "Tente novamente.");
    }
  };

  if (finished) return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <ScrollView contentContainerStyle={styles.reportScreen} showsVerticalScrollIndicator={false}>
        <Text style={[styles.reportHeading, { color: colors.foreground }]}>Treino concluído</Text>
        <View ref={reportRef} collapsable={false} style={[styles.reportCard, { backgroundColor: colors.background }]}>
          <Image source={require("@/assets/images/mytreinopro-symbol-small.png")} style={styles.reportLogo} />
          <Text style={[styles.reportBrand, { color: colors.primary }]}>MYTREINOPRO</Text>
          <Text style={[styles.reportTitle, { color: colors.foreground }]}>{workout.name}</Text>
          <Text style={[styles.reportDate, { color: colors.muted }]}>{new Date().toLocaleDateString("pt-BR", { dateStyle: "long" })}</Text>
          <View style={[styles.reportDivider, { backgroundColor: colors.border }]} />
          <View style={styles.reportStats}><ReportStat label="DURAÇÃO" value={`${Math.max(1, Math.round(durationSeconds / 60))} min`} colors={colors} /><ReportStat label="SÉRIES" value={String(completed)} colors={colors} /><ReportStat label="CALORIAS" value={`~${estimatedCalories} kcal`} colors={colors} /></View>
          <Text style={[styles.reportSectionLabel, { color: colors.primary }]}>EXERCÍCIOS</Text>
          <View style={styles.reportExercises}>{workout.exercises.slice(0, 8).map((item) => <View key={item.id} style={styles.reportExercise}><Text numberOfLines={1} style={[styles.reportExerciseName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.reportExerciseMeta, { color: colors.muted }]}>{item.sets} × {item.reps} · {item.loadKg || 0} kg</Text></View>)}</View>
          <Text style={[styles.reportDisclaimer, { color: colors.muted }]}>Calorias: estimativa aproximada, sem sensor de frequência cardíaca. O gasto real pode variar.</Text>
          <Text style={[styles.reportHandle, { color: colors.primary }]}>@mytreinopro</Text>
        </View>
        <Text style={[styles.shareHint, { color: colors.muted }]}>Use o menu nativo para escolher Instagram Stories, WhatsApp ou outro app. No WhatsApp, você pode enviar para uma conversa ou publicar manualmente no Status.</Text>
        <Pressable disabled={capturing} onPress={shareReport} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}>{capturing ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={styles.primaryButtonText}>{reportUri ? "Compartilhar relatório" : "Gerar e compartilhar imagem"}</Text>}</Pressable>
        <Pressable onPress={finish} style={styles.reportBackButton}><Text style={[styles.reportBackText, { color: colors.primary }]}>Salvar e voltar aos treinos</Text></Pressable>
      </ScrollView>
    </ScreenContainer>
  );

  return (
    <ScreenContainer className="px-5" containerClassName="bg-background">
      <View style={styles.runnerTop}>
        <Pressable onPress={() => onClose(workout)} style={styles.iconButton}><IconSymbol name="xmark" size={22} color={colors.foreground} /></Pressable>
        <Text style={[styles.detailTopTitle, { color: colors.foreground }]}>Executando treino</Text>
        <Text style={[styles.progressText, { color: colors.muted }]}>{exerciseIndex + 1}/{workout.exercises.length}</Text>
      </View>
      <View style={styles.runnerMain}>
        <Text style={[styles.eyebrow, { color: colors.primary }]}>EXERCÍCIO {exerciseIndex + 1}</Text>
        <Text style={[styles.runnerTitle, { color: colors.foreground }]}>{exercise.name}</Text>
        <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>Série {setIndex + 1} de {exercise.sets} · {exercise.reps} repetições</Text>
        <View style={[styles.timerCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.timerLabel, { color: colors.muted }]}>DESCANSO</Text>
          <Text style={[styles.timer, { color: remaining === 0 ? colors.success : colors.primary }]}>{formatTime(remaining)}</Text>
          <View style={styles.timerActions}>
            <Pressable onPress={resetTimer} style={[styles.timerSmallButton, { borderColor: colors.border }]}><IconSymbol name="gobackward" size={18} color={colors.foreground} /></Pressable>
            <Pressable onPress={togglePlay} style={[styles.timerPlay, { backgroundColor: colors.primary }]}><IconSymbol name={running ? "pause.fill" : "play.fill"} size={26} color="#FFF" /></Pressable>
            <Pressable onPress={skipTimer} style={[styles.timerSmallButton, { borderColor: colors.border }]}><IconSymbol name="forward.end.fill" size={18} color={colors.foreground} /></Pressable>
          </View>
        </View>
        <Pressable onPress={completeSet} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary, marginTop: 24 }, pressed && styles.pressed]}><IconSymbol name="checkmark" size={19} color="#FFF" /><Text style={styles.primaryButtonText}>{setIndex + 1 === exercise.sets && exerciseIndex + 1 === workout.exercises.length ? "Concluir treino" : "Concluir série"}</Text></Pressable>
      </View>
    </ScreenContainer>
  );
}

function ReportStat({ label, value, colors }: { label: string; value: string; colors: any }) {
  return <View style={styles.reportStat}><Text style={[styles.reportStatLabel, { color: colors.muted }]}>{label}</Text><Text style={[styles.reportStatValue, { color: colors.foreground }]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  homeScroll: { flex: 1 },
  homeContent: { paddingBottom: 28 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingTop: 18, paddingBottom: 22 },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 12, fontWeight: "800", letterSpacing: 1.8, lineHeight: 16 },
  title: { fontSize: 34, fontWeight: "800", lineHeight: 39, marginTop: 8, letterSpacing: -1, flexShrink: 1 },
  headerBadge: { width: 46, height: 46, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  headerLogo: { width: 40, height: 40, borderRadius: 12 },
  statsCard: { minHeight: 112, borderRadius: 24, padding: 20, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  moduleRow: { flexDirection: "row", gap: 10, marginBottom: 22 },
  moduleCard: { flex: 1, minHeight: 124, borderWidth: 1, borderRadius: 18, padding: 13, gap: 7 },
  moduleTitle: { fontSize: 14, fontWeight: "900" },
  moduleText: { fontSize: 12, lineHeight: 17 },
  statsLabel: { color: "#BFE7E2", fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  statsTitle: { color: "#FFF", fontSize: 17, fontWeight: "700", marginTop: 8, maxWidth: 205, lineHeight: 23 },
  statPill: { alignItems: "center", backgroundColor: "#FFFFFF20", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
  statNumber: { color: "#FFF", fontWeight: "800", fontSize: 24 },
  statCaption: { color: "#D5F0ED", fontSize: 11, marginTop: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 26, paddingBottom: 12 },
  sectionTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.4 },
  sectionSubtitle: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  addButton: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75, transform: [{ scale: 0.97 }] },
  listContent: { gap: 12, paddingBottom: 12 },
  workoutCard: { minHeight: 78, borderWidth: 1, borderRadius: 18, flexDirection: "row", alignItems: "stretch" },
  workoutCardMain: { flex: 1, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  reorderColumn: { justifyContent: "center", alignItems: "center", paddingRight: 10, gap: 2 },
  reorderButton: { width: 30, height: 26, alignItems: "center", justifyContent: "center" },
  reorderButtonDisabled: { opacity: 0.35 },
  cardIcon: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  cardCopy: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: "700" },
  cardMeta: { fontSize: 13, lineHeight: 18, marginTop: 5 },
  cardDays: { fontSize: 11, fontWeight: "800", marginTop: 5, letterSpacing: 0.3 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14 },
  footerText: { fontSize: 12 },
  empty: { borderWidth: 1, borderStyle: "dashed", borderRadius: 22, alignItems: "center", padding: 25, marginTop: 10 },
  emptyIcon: { width: 64, height: 64, borderRadius: 22, alignItems: "center", justifyContent: "center", marginBottom: 14 },
  emptyTitle: { fontSize: 18, fontWeight: "800" },
  emptyText: { textAlign: "center", fontSize: 14, lineHeight: 20, marginTop: 7, maxWidth: 275 },
  primaryButton: { height: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, paddingHorizontal: 20 },
  primaryButtonText: { color: "#FFF", fontSize: 16, fontWeight: "800" },
  detailTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingBottom: 25 },
  detailTopTitle: { fontSize: 16, fontWeight: "700" },
  editWorkoutButton: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 7 },
  editWorkoutText: { fontSize: 13, fontWeight: "800" },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  detailTitle: { fontSize: 32, fontWeight: "800", letterSpacing: -0.8 },
  detailDays: { fontSize: 12, fontWeight: "800", marginTop: 10, letterSpacing: 0.3 },
  detailExercise: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 17, borderWidth: 1 },
  indexCircle: { width: 32, height: 32, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  indexText: { color: "#FFF", fontWeight: "800" },
  exerciseName: { fontSize: 15, fontWeight: "700" },
  restText: { fontSize: 13, fontWeight: "800" },
  deleteButton: { alignItems: "center", justifyContent: "center", paddingVertical: 17 },
  deleteText: { fontWeight: "700", fontSize: 14 },
  modalHeader: { height: 62, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#DDE5E1", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  modalCancel: { fontSize: 15 },
  modalTitle: { fontSize: 17, fontWeight: "800" },
  modalSave: { fontSize: 15, fontWeight: "800" },
  editorContent: { padding: 20, paddingBottom: 40 },
  inputLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginBottom: 8 },
  textInput: { height: 52, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, fontSize: 16 },
  daysRow: { flexDirection: "row", gap: 7 },
  dayChip: { flex: 1, height: 42, borderWidth: 1.5, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  dayChipText: { fontSize: 12, fontWeight: "800" },
  editorExercise: { borderWidth: 1, borderRadius: 15, padding: 13, flexDirection: "row", alignItems: "center", marginBottom: 8, gap: 8 },
  exerciseActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  addExerciseBox: { borderWidth: 1, borderRadius: 18, padding: 15, marginTop: 5 },
  addExerciseTitle: { fontSize: 16, fontWeight: "800", marginBottom: 12 },
  smallInput: { height: 48, borderWidth: 1, borderRadius: 13, paddingHorizontal: 13, fontSize: 15, marginBottom: 12 },
  inputRow: { flexDirection: "row", gap: 8, marginBottom: 14 },
  suggestionChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8 },
  suggestionText: { fontSize: 12, fontWeight: "700" },
  miniLabel: { fontSize: 10, marginBottom: 5 },
  numberInput: { height: 42, borderWidth: 1, borderRadius: 11, paddingHorizontal: 8, fontSize: 14 },
  outlineButton: { height: 46, borderWidth: 1.5, borderRadius: 13, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 7 },
  outlineButtonText: { fontSize: 14, fontWeight: "800" },
  runnerTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 12 },
  progressText: { fontSize: 13, fontWeight: "700" },
  runnerMain: { flex: 1, justifyContent: "center", paddingBottom: 50 },
  runnerTitle: { fontSize: 34, fontWeight: "800", lineHeight: 40, marginTop: 8, letterSpacing: -0.8 },
  timerCard: { borderWidth: 1, borderRadius: 25, alignItems: "center", paddingVertical: 28, marginTop: 30 },
  timerLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  timer: { fontSize: 66, lineHeight: 78, fontWeight: "800", letterSpacing: -2, marginVertical: 7 },
  timerActions: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 8 },
  timerSmallButton: { width: 42, height: 42, borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  timerPlay: { width: 58, height: 58, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  reportScreen: { alignItems: "center", paddingTop: 18, paddingBottom: 28, gap: 14 },
  reportHeading: { fontSize: 24, fontWeight: "900", alignSelf: "flex-start" },
  reportCard: { width: "100%", aspectRatio: 9 / 16, borderRadius: 24, padding: 22, justifyContent: "flex-start", overflow: "hidden" },
  reportLogo: { width: 54, height: 54, borderRadius: 16, alignSelf: "flex-end" },
  reportBrand: { fontSize: 12, fontWeight: "900", letterSpacing: 2, marginTop: 18 },
  reportTitle: { fontSize: 29, fontWeight: "900", marginTop: 12 },
  reportDate: { fontSize: 13, marginTop: 7 },
  reportDivider: { height: 1, width: "100%", marginVertical: 18 },
  reportStats: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  reportStat: { flex: 1 },
  reportStatLabel: { fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  reportStatValue: { fontSize: 16, fontWeight: "900", marginTop: 5 },
  reportSectionLabel: { fontSize: 10, fontWeight: "900", letterSpacing: 1.5, marginTop: 22 },
  reportExercises: { gap: 9, marginTop: 10 },
  reportExercise: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  reportExerciseName: { flex: 1, fontSize: 12, fontWeight: "800" },
  reportExerciseMeta: { fontSize: 11 },
  reportDisclaimer: { fontSize: 9, lineHeight: 13, marginTop: "auto" },
  reportHandle: { alignSelf: "center", fontSize: 13, fontWeight: "900", marginTop: 16 },
  shareHint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  reportBackButton: { paddingVertical: 12 },
  reportBackText: { fontWeight: "900", fontSize: 14 },
  finished: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 90 },
  finishIcon: { width: 84, height: 84, borderRadius: 30, alignItems: "center", justifyContent: "center", marginBottom: 22 },
  finishTitle: { fontSize: 30, fontWeight: "800", letterSpacing: -0.6 },
});
