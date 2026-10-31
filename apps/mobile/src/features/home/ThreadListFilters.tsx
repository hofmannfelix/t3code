import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { startGlobalAudioSession, useIsAudioSessionActive } from "../threads/useReadAloud";
import { ListFilterMenu } from "../workspace/ListFilterMenu";
import type { HomeHeaderProps } from "./HomeHeader.types";

export function ThreadListFilters(
  props: Pick<
    HomeHeaderProps,
    | "environments"
    | "projects"
    | "selectedEnvironmentId"
    | "selectedProjectKey"
    | "onEnvironmentChange"
    | "onProjectChange"
  >,
) {
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const isAudioSessionActive = useIsAudioSessionActive();
  return (
    <View className="flex-row items-start">
      <ScrollView
        horizontal
        className="flex-1"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10, gap: 8 }}
      >
        <ListFilterMenu
          label={selectedEnvironment?.label ?? "All environments"}
          accessibilityLabel="Filter threads by environment"
          active={selectedEnvironment !== undefined}
          actions={[
            {
              id: "all",
              title: "All environments",
              state: props.selectedEnvironmentId === null ? "on" : "off",
            },
            ...props.environments.map((environment) => ({
              id: JSON.stringify(environment.environmentId),
              title: environment.label,
              state:
                environment.environmentId === props.selectedEnvironmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onEnvironmentChange(null);
            else {
              const environment = props.environments.find(
                (candidate) => JSON.stringify(candidate.environmentId) === id,
              );
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }
          }}
        />
        <ListFilterMenu
          label={selectedProject?.label ?? "All projects"}
          accessibilityLabel="Filter threads by project"
          active={selectedProject !== undefined}
          actions={[
            {
              id: "all",
              title: "All projects",
              state: props.selectedProjectKey === null ? "on" : "off",
            },
            ...props.projects.map((project) => ({
              id: JSON.stringify(project.key),
              title: project.label,
              state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onProjectChange(null);
            else {
              const project = props.projects.find(
                (candidate) => JSON.stringify(candidate.key) === id,
              );
              if (project) props.onProjectChange(project.key);
            }
          }}
        />
        {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset thread filters"
            className="h-8 w-8 items-center justify-center"
            onPress={() => {
              props.onEnvironmentChange(null);
              props.onProjectChange(null);
            }}
          >
            <SymbolView name="xmark.circle.fill" size={18} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </ScrollView>
      {isAudioSessionActive ? null : (
        // Without a thread target the session reads every thread that finishes.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Audio vorlesen aktivieren"
          hitSlop={8}
          className="mr-4 mt-0.5 h-8 w-8 items-center justify-center active:opacity-70"
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            void startGlobalAudioSession();
          }}
        >
          <SymbolView name="speaker.wave.2" size={17} tintColorClassName="accent-icon-muted" />
        </Pressable>
      )}
    </View>
  );
}
