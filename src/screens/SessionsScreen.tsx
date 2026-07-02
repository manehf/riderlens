import { AlertTriangle, Clock3, FileVideo, Share2 } from "lucide-react-native";
import { ScrollView, StyleSheet, View } from "react-native";

import { AnalysisFrames } from "../components/AnalysisFrames";
import { AppText, BrandHeader, Button, Card, Chip, Heading, MetricTile, NumberText, SectionHeader } from "../components/ui";
import type { RiderLensStore } from "../hooks/useRiderLensMvp";
import { getFrameMediaSource, getGeometrySourceLabel, getSkillLabel, hasVerifiedGeometry } from "../services/analysis";
import { spacing, tokens } from "../theme/tokens";
import type { JobStatus, RideSession } from "../types/domain";

type SessionsScreenProps = {
  store: RiderLensStore;
};

export function SessionsScreen({ store }: SessionsScreenProps) {
  const active = store.activeSession;

  return (
    <View style={styles.root}>
      <BrandHeader subtitle="My sessions" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SectionHeader
          eyebrow="Sessions"
          title="Review analysis history"
          body="Each session keeps its source, status, key frames, measured angles, coaching notes, and share text."
        />

        <View style={styles.sessionList}>
          {store.sessions.length === 0 ? (
            <Card style={styles.emptySessionsCard}>
              <View style={styles.emptySessionsIcon}>
                <FileVideo color={tokens.green} size={20} />
              </View>
              <View style={styles.emptySessionsText}>
                <AppText weight="bold">No jump analyses yet</AppText>
                <AppText color={tokens.textMuted} size={13}>
                  Record or upload a regular jump from Coach to start your history.
                </AppText>
              </View>
            </Card>
          ) : (
            store.sessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === active?.id}
                onPress={() => store.selectSession(session.id)}
              />
            ))
          )}
        </View>

        {active ? (
          <Card style={styles.detailCard}>
            <View style={styles.detailHeader}>
              <View style={styles.detailTitle}>
                <Chip tone={getSessionTone(active)}>{getSessionHeadline(active)}</Chip>
                <Heading level={2}>{active.title}</Heading>
                <AppText color={tokens.textMuted} size={13}>
                  {getSkillLabel(active.skillType)} clip
                </AppText>
              </View>
              <Button icon={Share2} variant="secondary" onPress={store.shareActiveReport} style={styles.shareButton}>
                Share
              </Button>
            </View>

            <VideoSessionDetail session={active} />
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

function VideoSessionDetail({ session }: { session: RideSession }) {
  const mediaSource = getFrameMediaSource(session);
  const verifiedGeometry = hasVerifiedGeometry(session.metrics[0]);

  return (
    <>
      <View style={styles.videoStats}>
        {session.video ? (
          <>
            <MetricTile label="Duration" value={session.video.durationSeconds.toFixed(1)} unit="s" />
            <MetricTile label="Frame rate" value={session.video.fps} unit="fps" />
          </>
        ) : (
          <MetricTile label="Frames" value={session.metrics.length} />
        )}
        <MetricTile label="Mode" value={getGeometrySourceLabel(session.metrics[0])} />
      </View>

      {session.video ? (
        <View style={styles.clipWindow}>
          <Chip tone="cyan">Selected jump window</Chip>
          <View style={styles.clipWindowValues}>
            <NumberText weight="bold" color={tokens.green}>
              {session.video.trimStartSeconds.toFixed(1)}s
            </NumberText>
            <AppText color={tokens.textMuted}>to</AppText>
            <NumberText weight="bold" color={tokens.green}>
              {session.video.trimEndSeconds.toFixed(1)}s
            </NumberText>
            <Chip tone="neutral">{session.video.cropPreset.replace(/_/g, " ")}</Chip>
          </View>
        </View>
      ) : null}

      <AnalysisFrames metrics={session.metrics} mediaSource={mediaSource} />

      {verifiedGeometry ? (
        <View style={styles.phaseGrid}>
          {session.metrics.map((metric) => (
            <View key={metric.id} style={styles.phaseCard}>
              <View style={styles.phaseHeader}>
                <AppText weight="bold" size={13} style={styles.phaseName}>
                  {metric.phase}
                </AppText>
                <NumberText weight="bold" size={12} color={tokens.green}>
                  {metric.frameTime.toFixed(1)}s
                </NumberText>
              </View>
              <View style={styles.phaseMetricRow}>
                <MetricTile label="Floor" value={metric.floorAngle ?? 0} unit="deg" />
                <MetricTile label="Tire base" value={metric.tireBaselineAngle ?? metric.bikePitchAngle} unit="deg" />
              </View>
              <View style={styles.phaseMetricRow}>
                <MetricTile label="Torso" value={metric.torsoAngle} unit="deg" />
                <MetricTile label="Knee" value={metric.kneeAngle} unit="deg" />
                <MetricTile label="Landing" value={metric.landingAlignmentAngle ?? 0} unit="deg" />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.emptyReport}>
          <AlertTriangle color={tokens.amber} size={20} />
          <AppText weight="semi" color={tokens.textMuted}>
            Geometry calibration required before angle analysis is valid.
          </AppText>
        </View>
      )}

      {session.report ? (
        <View style={styles.reportBlock}>
          <Heading level={3}>Coaching notes</Heading>
          <AppText color={tokens.textMuted} style={styles.reportSummary}>
            {session.report.summary}
          </AppText>
          <View style={styles.reportColumns}>
            <ReportColumn title="Strengths" items={session.report.strengths} tone="green" />
            <ReportColumn title="Drills" items={session.report.drills} tone="cyan" />
          </View>
        </View>
      ) : (
        <View style={styles.emptyReport}>
          <Clock3 color={tokens.amber} size={20} />
          <AppText weight="semi" color={tokens.textMuted}>
            Analysis is still processing.
          </AppText>
        </View>
      )}
    </>
  );
}

function SessionListItem({ session, active, onPress }: { session: RideSession; active: boolean; onPress: () => void }) {
  const statusTone = getSessionTone(session);
  const progress = Math.round((session.job?.progress ?? 0) * 100);
  const Icon = FileVideo;

  return (
    <Card style={[styles.sessionCard, active && styles.activeSessionCard]}>
      <View style={styles.sessionRow}>
        <View style={styles.sessionIcon}>
          <Icon color={active ? tokens.graphite : tokens.green} size={18} strokeWidth={2.4} />
        </View>
        <View style={styles.sessionText}>
          <AppText weight="bold">{session.title}</AppText>
          <AppText color={tokens.textMuted} size={13}>
            {getSkillLabel(session.skillType)}
          </AppText>
        </View>
        <Chip tone={statusTone}>
          {getSessionStatusLabel(session)}
        </Chip>
      </View>
      <View style={styles.sessionFooter}>
        <NumberText color={tokens.textMuted} size={12} weight="bold">
          {new Date(session.createdAt).toLocaleDateString()}
        </NumberText>
        <Button variant={active ? "dark" : "secondary"} onPress={onPress} style={styles.reviewButton}>
          {active ? "Selected" : "Review"}
        </Button>
      </View>
      {session.job && session.job.status !== "completed" ? (
        <View style={styles.sessionProgress}>
          <View style={[styles.sessionProgressFill, { width: `${Math.max(8, progress)}%` }]} />
        </View>
      ) : null}
    </Card>
  );
}

function ReportColumn({ title, items, tone }: { title: string; items: string[]; tone: "green" | "cyan" }) {
  return (
    <View style={styles.reportColumn}>
      <Chip tone={tone}>{title}</Chip>
      {items.map((item) => (
        <View key={item} style={styles.bulletRow}>
          <View style={[styles.bullet, tone === "cyan" && styles.bulletCyan]} />
          <AppText size={13}>{item}</AppText>
        </View>
      ))}
    </View>
  );
}

function getSessionTone(session: RideSession): "green" | "amber" | "red" | "neutral" {
  if (session.status === "analysis_failed") return "red";
  return getJobTone(session.job?.status);
}

function getSessionHeadline(session: RideSession): string {
  if (session.status === "complete") return "Report ready";
  if (session.status === "analysis_failed") return "Analysis failed";
  return "Analyzing";
}

function getSessionStatusLabel(session: RideSession): string {
  if (session.status === "analysis_failed") return "failed";
  return session.job?.status ?? "draft";
}

function getJobTone(status?: JobStatus): "green" | "amber" | "red" | "neutral" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "processing" || status === "queued") return "amber";
  return "neutral";
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  },
  content: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingBottom: 120
  },
  sessionList: {
    gap: spacing.md
  },
  emptySessionsCard: {
    minHeight: 112,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  emptySessionsIcon: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: tokens.electricSoft
  },
  emptySessionsText: {
    flex: 1,
    gap: spacing.xs
  },
  sessionCard: {
    gap: spacing.md,
    padding: spacing.md
  },
  activeSessionCard: {
    borderColor: tokens.electric,
    backgroundColor: tokens.electricSoft
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md
  },
  sessionIcon: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.surfaceMuted
  },
  sessionText: {
    flex: 1,
    gap: 2
  },
  sessionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  reviewButton: {
    minHeight: 36,
    paddingHorizontal: spacing.md
  },
  sessionProgress: {
    height: 7,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: tokens.surfaceMuted
  },
  sessionProgressFill: {
    height: "100%",
    backgroundColor: tokens.green
  },
  detailCard: {
    gap: spacing.lg
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md
  },
  detailTitle: {
    flex: 1,
    gap: spacing.xs
  },
  shareButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md
  },
  videoStats: {
    flexDirection: "row",
    gap: spacing.sm
  },
  clipWindow: {
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  },
  clipWindowValues: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm
  },
  phaseGrid: {
    gap: spacing.md
  },
  phaseCard: {
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.md
  },
  phaseHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  phaseName: {
    textTransform: "capitalize"
  },
  phaseMetricRow: {
    flexDirection: "row",
    gap: spacing.sm
  },
  reportBlock: {
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: tokens.border,
    paddingTop: spacing.lg
  },
  reportSummary: {
    lineHeight: 21
  },
  reportColumns: {
    gap: spacing.lg
  },
  reportColumn: {
    gap: spacing.sm
  },
  bulletRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm
  },
  bullet: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: tokens.green,
    marginTop: 7
  },
  bulletCyan: {
    backgroundColor: tokens.cyan
  },
  emptyReport: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm
  },
});
