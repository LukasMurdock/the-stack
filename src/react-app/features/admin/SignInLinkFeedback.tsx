import type { UseMutationResult } from "@tanstack/react-query";
import { MutationFeedback } from "../../forms/feedback";
import {
	signInLinkCopy,
	type SignInLinkSent,
	type SignInLinkTarget,
} from "./useSignInLink";

export function SignInLinkFeedback({
	send,
}: {
	send: UseMutationResult<SignInLinkSent, Error, SignInLinkTarget>;
}) {
	return (
		<MutationFeedback
			error={send.error}
			success={
				send.data ? signInLinkCopy.sent(send.data.sentTo) : undefined
			}
		/>
	);
}
