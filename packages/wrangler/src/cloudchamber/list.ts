import { logRaw, shapes, space } from "@cloudflare/cli";
import {
	bgRed,
	dim,
	yellow,
	green,
	brandColor,
	gray,
	white,
	bgCyan,
} from "@cloudflare/cli/colors";
import { spinner, inputPrompt } from "@cloudflare/cli/interactive";
import isInteractive from "../is-interactive";
import { listDeploymentsAndChoose, loadDeployments } from "./cli/deployments";
import { statusToColored } from "./cli/util";
import { DeploymentsService, PlacementsService } from "./client";
import { handleFailure, loadAccountSpinner, promiseSpinner } from "./common";
import type { CommonYargsOptions } from "../yargs-types";
import type { PlacementEvent, PlacementWithEvents, State } from "./client";
import type {
	CommonCloudchamberConfiguration,
	CloudchamberConfiguration,
	inferYargsFn,
} from "./common";
import type { EventName } from "./enums";
import type { Argv } from "yargs";

export function listDeploymentsYargs<T>(args: Argv<T>) {
	return args
		.option("location", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "Filter deployments by location",
		})
		.option("image", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "Filter deployments by image",
		})
		.option("state", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "Filter deployments by deployment state",
		})
		.option("ipv4", {
			requiresArg: true,
			type: "string",
			demandOption: false,
			describe: "Filter deployments by ipv4 address",
		});
}

export const listCommand = (
	yargs: Argv<CommonYargsOptions & CommonCloudchamberConfiguration>
) => {
	return yargs.command(
		"list [deploymentIdPrefix]",
		"List and view status of deployments",
		(args) =>
			listDeploymentsYargs(args).positional("deploymentIdPrefix", {
				describe:
					"Optional deploymentId to filter deployments\nThis means that 'list' will only showcase deployments that contain this ID prefix",
				type: "string",
			}),
		(args) =>
			handleFailure<typeof args>(async (deploymentArgs, config) => {
				await loadAccountSpinner(config);
				const prefix = (deploymentArgs.deploymentIdPrefix ?? "") as string;
				if (config.json || !isInteractive()) {
					const deployments = (
						await DeploymentsService.listDeployments(
							deploymentArgs.location,
							deploymentArgs.image,
							deploymentArgs.state as State,
							deploymentArgs.ipv4
						)
					).filter((deployment) => deployment.id.startsWith(prefix));
					if (deployments.length === 1) {
						const placements = await PlacementsService.listPlacements(
							deployments[0].id
						);
						console.log(
							JSON.stringify(
								{
									...deployments[0],
									placements,
								},
								null,
								4
							)
						);
						return;
					}

					console.log(JSON.stringify(deployments, null, 4));
					return;
				}

				await listCommandHandle(prefix, deploymentArgs, config);
			})(args)
	);
};

/**
 * Renders an event message depending on the event type and if it's the last event
 */
function eventMessage(event: PlacementEvent, lastEvent: boolean): string {
	let { message } = event;
	const name = event.name as EventName;
	const health = event.statusChange["health"];
	if (health === "failed") {
		message = `${bgRed(" X ")} ${dim(message)}`;
	} else if (lastEvent && name === "VMStopped") {
		message = `${yellow(message)}`;
	} else if ((lastEvent && name === "VMStarted") || name === "SSHStarted") {
		message = `${green(message)}`;
	} else if (lastEvent) {
		message = `${brandColor(message)}`;
	} else {
		message = dim(message);
	}

	return `${message} (${event.time})`;
}

const listCommandHandle = async (
	deploymentIdPrefix: string,
	args: inferYargsFn<typeof listDeploymentsYargs>,
	_config: CloudchamberConfiguration
) => {
	const keepListIter = true;
	while (keepListIter) {
		logRaw(gray(shapes.bar));
		const deployments = await loadDeployments(deploymentIdPrefix, args);
		const deployment = await listDeploymentsAndChoose(deployments);
		const placementToOptions = (p: PlacementWithEvents) => {
			return {
				label: `Placement ${p.id.slice(0, 6)} (${p.created_at})`,
				details: [
					`ID: ${dim(p.id)}`,
					`Version: ${dim(`${p.deployment_version}`)}`,
					`Status: ${statusToColored(p.status["health"])}`,
					`${bgCyan(white(`Events`))}`,
					...p.events.map(
						(event, i) =>
							space(1) + eventMessage(event, i === p.events.length - 1)
					),
				],
				value: p.id,
			};
		};

		const loadPlacements = () => {
			return PlacementsService.listPlacements(deployment.id);
		};
		const placements = await promiseSpinner(loadPlacements(), {
			message: "Loading placements",
		});
		const { start, stop } = spinner();
		let refresh = false;
		await inputPrompt({
			type: "list",
			question: "Placements",
			helpText: "Hint: Press R to refresh! Or press return to go back",
			options: placements.map(placementToOptions),
			label: "going back",
			onRefresh: async () => {
				start("Refreshing placements");
				const options = (await loadPlacements()).map(placementToOptions);
				if (refresh) return [];
				stop();
				if (options.length)
					options[0].label += ", last refresh: " + new Date().toLocaleString();
				return options;
			},
		});
		refresh = true;
		stop();
	}
};
